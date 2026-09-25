import { useCallback, useEffect, useState } from "react";
import { ThemeProvider } from "@/components/theme-provider";
import { BrowserViewer } from "./viewer";

type HostCommand = { version:1; visit_id:string; request_id:string; command:"suspend"|"resume" };
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
  const valid=location.pathname===`/browser-mobile/${sessionId}` && /^browser_[0-9A-HJKMNP-TV-Z]{26}$/.test(sessionId)
    && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(viewerId)
    && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(visitId)
    && query.getAll("viewer_id").length===1 && query.getAll("visit_id").length===1
    && [...query.keys()].length===2 && !location.hash;
  const publish=useCallback((event:string, fields:Record<string,unknown>={})=>{
    window.webkit?.messageHandlers?.budBrowser?.postMessage({version:1,visit_id:visitId,event,...fields});
  },[visitId]);
  const authorizationLost=useCallback(()=>publish("authorization_lost"),[publish]);
  useEffect(()=>{
    if(!valid)return;
    let live=true, generation=0;
    const seen=new Set<string>();
    window.budBrowserCommand=command=>{
      if(command?.version!==1||command.visit_id!==visitId||typeof command.request_id!=="string"||!command.request_id.length||command.request_id.length>64||seen.has(command.request_id))return;
      seen.add(command.request_id);if(seen.size>64)seen.delete(seen.values().next().value!);
      if(command.command==="suspend")setActive(false);
      else if(command.command==="resume")setActive(true);
      else {publish("result",{request_id:command.request_id,accepted:false});return;}
      const fence=++generation;
      // Acceptance is not proof of a completed control transition.
      // Allow React to commit the lifecycle fence before native uncovers pixels.
      requestAnimationFrame(()=>requestAnimationFrame(()=>{
        if(live)publish("result",{request_id:command.request_id,accepted:fence===generation});
      }));
    };
    const visibility=()=>{if(document.hidden){generation++;setActive(false);}};
    document.addEventListener("visibilitychange",visibility);
    publish("ready");
    return ()=>{live=false;delete window.budBrowserCommand;document.removeEventListener("visibilitychange",visibility);};
  },[publish,visitId,valid]);
  if(!valid)return <p>Invalid browser visit.</p>;
  return <ThemeProvider><div className="h-full" style={{height:"100svh"}}>
    <BrowserViewer sessionId={sessionId} hostViewerId={viewerId} mobile embedded active={active}
      onAuthorizationLost={authorizationLost} onDismiss={()=>publish("dismiss")}/>
    {!active&&<div className="fixed inset-0 z-50 bg-background" role="status">Browser paused</div>}
  </div></ThemeProvider>;
}
