/** Imperative local zoom/pan; only default-scale vertical swipes reach Chrome. */
export function installBrowserTouch(canvas: HTMLCanvasElement, scroll: (dy: number) => void, identity: () => string = () => "") {
  const fingers = new Map<number, {x:number;y:number}>();
  let scale=1, x=0, y=0, distance=0, dragged=false, suppressUntil=0;
  const paint=()=>{ canvas.style.transform=`translate(${x}px, ${y}px) scale(${scale})`; };
  const span=()=>{const [a,b]=[...fingers.values()];return a&&b?Math.hypot(a.x-b.x,a.y-b.y):0;};
  let page = identity();
  const reset = () => { fingers.clear(); scale=1; x=0; y=0; distance=0; dragged=false; suppressUntil=Date.now()+500; paint(); };
  const changed = () => { const next=identity(); if(next===page)return false; page=next;reset();return true; };
  const down=(e:PointerEvent)=>{
    if(e.pointerType!=="touch") return;
    changed();
    if(!fingers.size) dragged=false;
    fingers.set(e.pointerId,{x:e.clientX,y:e.clientY});
    canvas.setPointerCapture(e.pointerId);
    distance=span();
  };
  const move=(e:PointerEvent)=>{
    if(changed())return;
    const before=fingers.get(e.pointerId); if(!before) return;
    const dx=e.clientX-before.x,dy=e.clientY-before.y;
    if(fingers.size===1&&!dragged&&Math.hypot(dx,dy)<8) return;
    dragged=true;
    fingers.set(e.pointerId,{x:e.clientX,y:e.clientY});
    if(fingers.size>1){const next=span();if(distance)scale=Math.min(4,Math.max(1,scale*next/distance));distance=next;}
    else if(scale>1.01){x+=dx;y+=dy;}
    else scroll(-dy);
    if(scale<=1.01){scale=1;x=0;y=0;}
    // Keep the page within reach even after repeated panning.
    x=Math.max(-canvas.clientWidth*(scale-1)/2,Math.min(canvas.clientWidth*(scale-1)/2,x));
    y=Math.max(-canvas.clientHeight*(scale-1)/2,Math.min(canvas.clientHeight*(scale-1)/2,y));
    paint();
  };
  const up=(e:PointerEvent)=>{if(dragged)suppressUntil=Date.now()+500;fingers.delete(e.pointerId);distance=span();};
  const click=(e:MouseEvent)=>{if(Date.now()<suppressUntil){e.preventDefault();e.stopImmediatePropagation();}};
  globalThis.addEventListener?.("resize",reset);
  canvas.style.touchAction="none";
  canvas.addEventListener("pointerdown",down);canvas.addEventListener("pointermove",move);
  canvas.addEventListener("pointerup",up);canvas.addEventListener("pointercancel",up);canvas.addEventListener("click",click,true);
  return ()=>{globalThis.removeEventListener?.("resize",reset);canvas.removeEventListener("pointerdown",down);canvas.removeEventListener("pointermove",move);canvas.removeEventListener("pointerup",up);canvas.removeEventListener("pointercancel",up);canvas.removeEventListener("click",click,true);canvas.style.transform="";canvas.style.touchAction="";};
}
