import { useCallback, useEffect, useRef, useState } from "react";
import { ThemeProvider } from "@/components/theme-provider";
import { BrowserViewer, type BrowserReturnAction } from "./viewer";

type HostCommand = { version:1; visit_id:string; request_id:string; command:"suspend"|"resume"|"return_to_agent" };
declare global {
  interface Window {
    webkit?: {messageHandlers?: {budBrowser?: {postMessage:(message:unknown)=>void}}};
    budBrowserCommand?: (command:HostCommand)=>void;
  }
}

/** First-party shell only. Native owns presentation, never media or input. */
export function MobileBrowserEntry() {
  const sessionId=location.pathname.split("/")[2] ?? "";
  const query=new URLSearchParams(location.search);
  const viewerId=query.get("viewer_id") ?? "", visitId=query.get("visit_id") ?? "";
  const [active,setActive]=useState(false);
  const action=useRef<BrowserReturnAction|null>(null);
  const publish=useCallback((event:string, fields:Record<string,unknown>={})=>{
    window.webkit?.messageHandlers?.budBrowser?.postMessage({version:1,visit_id:visitId,event,...fields});
  },[visitId]);
  const setAction=useCallback((next:BrowserReturnAction|null)=>{
    action.current=next;
    publish("state",{can_return:!!next&&!next.disabled,returning:next?.returning??false});
  },[publish]);
  useEffect(()=>{
    const seen=new Set<string>();
    window.budBrowserCommand=command=>{
      if(command?.version!==1||command.visit_id!==visitId||typeof command.request_id!=="string"||command.request_id.length>64||seen.has(command.request_id))return;
      seen.add(command.request_id);if(seen.size>64)seen.delete(seen.values().next().value!);
      if(command.command==="suspend")setActive(false);
      else if(command.command==="resume")setActive(true);
      else if(command.command==="return_to_agent"){
        const next=action.current;
        if(!next||next.disabled){publish("result",{request_id:command.request_id,accepted:false});return;}
        next.run();
      } else return;
      // Acceptance is not proof of a completed control transition.
      // Allow React to commit the lifecycle fence before native uncovers pixels.
      requestAnimationFrame(()=>requestAnimationFrame(()=>publish("result",{request_id:command.request_id,accepted:true})));
    };
    const visibility=()=>{if(document.hidden)setActive(false);};
    document.addEventListener("visibilitychange",visibility);
    publish("ready");
    return ()=>{delete window.budBrowserCommand;document.removeEventListener("visibilitychange",visibility);};
  },[publish,visitId]);
  if(!/^browser_[0-9A-HJKMNP-TV-Z]{26}$/.test(sessionId)||!/^[-a-f0-9]{36}$/i.test(viewerId)||! /^[0-9A-HJKMNP-TV-Z]{26}$/.test(visitId))return <p>Invalid browser visit.</p>;
  return <ThemeProvider><div className="h-full" style={{height:"100svh"}}>
    <BrowserViewer sessionId={sessionId} hostViewerId={viewerId} mobile embedded active={active}
      onReturnActionChange={setAction} onDismiss={()=>publish("dismiss")}/>
    {!active&&<div className="fixed inset-0 z-50 bg-background" role="status">Browser paused</div>}
  </div></ThemeProvider>;
}
