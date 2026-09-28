type TouchClock = {
  now: () => number;
  request: (callback: () => void) => number;
  cancel: (id: number) => void;
};
const clock: TouchClock = {
  now: () => performance.now(),
  request: callback => requestAnimationFrame(callback),
  cancel: id => cancelAnimationFrame(id),
};

/** Imperative local zoom/pan; only default-scale vertical swipes reach Chrome. */
export function installBrowserTouch(canvas: HTMLCanvasElement, scroll: (dy: number, point: {clientX:number;clientY:number}, momentum: boolean) => void | boolean | number | "busy", identity: () => string = () => "", timing: TouchClock = clock) {
  const fingers = new Map<number, {x:number;y:number}>();
  let anchor={clientX:0,clientY:0};
  let scale=1, x=0, y=0, distance=0, dragged=false, suppressUntil=0;
  let samples: {time:number;y:number}[] = [];
  let canFlick = false, animation: number | undefined;
  const stopMomentum = () => {
    if (animation !== undefined) timing.cancel(animation);
    animation = undefined;
    samples = [];
    canFlick = false;
  };
  const remember = (position: number) => {
    const now = timing.now();
    const last = samples.at(-1), previous = samples.at(-2);
    // A reversal starts a new velocity estimate, not a continuation of the flick.
    if (last && previous && (position-last.y)*(last.y-previous.y)<0) samples=[last];
    samples.push({time:now,y:position});
    while(samples.length>2 && samples[1].time<now-100) samples.shift();
  };
  const startMomentum = () => {
    const first=samples[0], last=samples.at(-1);
    const now=timing.now();
    if(!canFlick || !first || !last || now-last.time>80 || last.time-first.time<4) return;
    let velocity=Math.max(-4,Math.min(4,(first.y-last.y)/(last.time-first.time)));
    if(Math.abs(velocity)<0.3) return;
    const started=now;
    let previous=now, pending=0;
    let remaining=Math.max(1,canvas.clientHeight)*3;
    const tick=()=>{
      animation=undefined;
      if(changed()) return;
      const time=timing.now(), dt=time-previous;
      // Never catch up after suspension or drain a tail after its deadline.
      if(dt>1000 || time-started>3500) {stopMomentum();return;}
      previous=time;
      const decay=Math.exp(-dt/650);
      const travel=Math.min(remaining,Math.abs(velocity)*650*(1-decay));
      remaining-=travel;
      pending+=Math.sign(velocity)*travel;
      velocity*=decay;
      suppressUntil=Date.now()+500;
      if(Math.abs(pending)>=1) {
        const accepted=scroll(pending,anchor,true);
        if(accepted===false) {stopMomentum();return;}
        if(accepted!=="busy") {
          // A scaled viewport may hit the wire's per-wheel limit. Keep the
          // unsent remainder rather than treating a clipped wheel as full travel.
          const consumed=typeof accepted==="number" ? Math.min(Math.abs(pending),Math.max(0,accepted)) : Math.abs(pending);
          pending-=Math.sign(pending)*consumed;
        }
      }
      if((Math.abs(velocity)<0.03 || remaining<1) && Math.abs(pending)<1) {stopMomentum();return;}
      animation=timing.request(tick);
    };
    animation=timing.request(tick);
  };
  const paint=()=>{ canvas.style.transform=`translate(${x}px, ${y}px) scale(${scale})`; };
  const span=()=>{const [a,b]=[...fingers.values()];return a&&b?Math.hypot(a.x-b.x,a.y-b.y):0;};
  let page = identity();
  const reset = () => { stopMomentum(); fingers.clear(); scale=1; x=0; y=0; distance=0; dragged=false; suppressUntil=Date.now()+500; paint(); };
  const changed = () => { const next=identity(); if(next===page)return false; page=next;reset();return true; };
  const down=(e:PointerEvent)=>{
    if(e.pointerType!=="touch") return;
    const stopping=animation!==undefined;
    stopMomentum();
    if(stopping) suppressUntil=Date.now()+500;
    changed();
    canFlick=!fingers.size && scale===1;
    remember(e.clientY);
    if(!fingers.size) { dragged=false; anchor={clientX:e.clientX,clientY:e.clientY}; }
    else dragged=true;
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
    else { remember(e.clientY); if(scroll(-dy,anchor,false)===false) canFlick=false; }
    if(scale<=1.01){scale=1;x=0;y=0;}
    // Keep the page within reach even after repeated panning.
    x=Math.max(-canvas.clientWidth*(scale-1)/2,Math.min(canvas.clientWidth*(scale-1)/2,x));
    y=Math.max(-canvas.clientHeight*(scale-1)/2,Math.min(canvas.clientHeight*(scale-1)/2,y));
    paint();
  };
  const up=(e:PointerEvent)=>{
    if(changed() || !fingers.has(e.pointerId)) return;
    // Some quick gestures deliver their final (or only) displacement on up.
    const before=fingers.get(e.pointerId)!;
    if(before.x!==e.clientX || before.y!==e.clientY) move(e);
    if(dragged)suppressUntil=Date.now()+500;
    if(fingers.size===1 && dragged && scale===1) startMomentum();
    fingers.delete(e.pointerId);distance=span();
  };
  const cancel=()=>{stopMomentum();fingers.clear();distance=0;dragged=true;suppressUntil=Date.now()+500;};
  const lost=(e:PointerEvent)=>{if(fingers.has(e.pointerId))cancel();};
  const click=(e:MouseEvent)=>{changed();if(Date.now()<suppressUntil){e.preventDefault();e.stopImmediatePropagation();}};
  // Touching controls outside the canvas also stops the inertial tail.
  const outside=(event:Event)=>{if(event.target!==canvas) stopMomentum();};
  globalThis.addEventListener?.("pointerdown",outside,true);
  globalThis.addEventListener?.("resize",reset);
  globalThis.document?.addEventListener("visibilitychange",cancel);
  canvas.style.touchAction="none";
  canvas.addEventListener("pointerdown",down);canvas.addEventListener("pointermove",move);
  canvas.addEventListener("pointerup",up);canvas.addEventListener("pointercancel",cancel);canvas.addEventListener("lostpointercapture",lost);canvas.addEventListener("click",click,true);
  return ()=>{stopMomentum();globalThis.removeEventListener?.("pointerdown",outside,true);globalThis.document?.removeEventListener("visibilitychange",cancel);globalThis.removeEventListener?.("resize",reset);canvas.removeEventListener("pointerdown",down);canvas.removeEventListener("pointermove",move);canvas.removeEventListener("pointerup",up);canvas.removeEventListener("pointercancel",cancel);canvas.removeEventListener("lostpointercapture",lost);canvas.removeEventListener("click",click,true);canvas.style.transform="";canvas.style.touchAction="";};
}
