export function boundedPdfViewport(width,height,panelWidth,pixelRatio=1,zoom=100) {
  if(!(width>0&&height>0&&Number.isFinite(width*height)))throw new Error("Invalid PDF dimensions");
  if(!Number.isFinite(zoom)||zoom<50||zoom>200)throw new Error("Invalid PDF zoom");
  const requested=Math.max(100,panelWidth)/width*Math.min(2,Math.max(1,pixelRatio))*zoom/100;
  const scale=Math.min(requested,Math.sqrt(8000000/(width*height)),8192/width,8192/height);
  const result={scale,width:Math.max(1,Math.floor(width*scale)),height:Math.max(1,Math.floor(height*scale)),limited:scale<requested};
  if(!Number.isFinite(scale)||scale<=0||result.width>8192||result.height>8192||result.width*result.height>8000000)throw new Error("PDF dimensions exceed preview limit");return result;
}

// Canvas only: no annotation/link/form/scripting layer is ever created.
export function createPdfPreview({container,t,document:doc=container.ownerDocument,loadLibrary=()=>import("/vendor/pdfjs/pdf.mjs"),features={}}) {
  let generation=0,worker=null,loading=null,pdf=null,activeJob=null,closed=true,pageNumber=1,zoom=100,fitWidth=true,pageSequence=0,limited=false,rendering=false;
  let paintCurrent=null,pageInput=null,abortCleanup=null,resizeObserver=null,resizeTimer=null;
  const timers=new Set(),listeners=[];
  const label=(key,fallback)=>{const value=t?.(`files.${key}`);return !value||value===`files.${key}`?fallback||`files.${key}`:value;};
  const node=(tag,value)=>{const element=doc.createElement(tag);if(value!==undefined)element.textContent=value;return element;};
  const named=(tag,key,fallback)=>{const element=node(tag);element.setAttribute("aria-label",label(key,fallback));return element;};
  const listen=(element,type,handler)=>{element.addEventListener(type,handler);listeners.push(()=>element.removeEventListener(type,handler));};
  const message=value=>{container.replaceChildren(node("p",value));};
  const clearTimer=timer=>{clearTimeout(timer);timers.delete(timer);};
  const timeout=callback=>{const timer=setTimeout(()=>{timers.delete(timer);callback();},20000);timers.add(timer);return timer;};
  function cancelJob(){
    if(!activeJob)return;const old=activeJob;activeJob=null;clearTimer(old.timer);old.task?.cancel();old.page?.cleanup();
  }
  function destroy(){
    closed=true;generation++;pageSequence++;paintCurrent=null;pageInput=null;rendering=false;
    abortCleanup?.();abortCleanup=null;resizeObserver?.disconnect();resizeObserver=null;clearTimeout(resizeTimer);resizeTimer=null;
    for(const remove of listeners.splice(0))remove();for(const timer of timers)clearTimeout(timer);timers.clear();cancelJob();
    if(loading)void Promise.resolve(loading.destroy()).catch(()=>{});worker?.destroy();loading=null;worker=null;pdf=null;pageNumber=1;zoom=100;fitWidth=true;limited=false;container.replaceChildren();
  }
  function setView(value={}){
    if(closed||!pdf||!paintCurrent)return false;
    const page=value.page??pageNumber,nextZoom=value.zoom??zoom;
    if(!Number.isSafeInteger(page)||page<1||page>Math.min(pdf.numPages,200)||!Number.isFinite(nextZoom)||nextZoom<50||nextZoom>200)return false;
    pageNumber=page;zoom=nextZoom;if(value.zoom!==undefined)fitWidth=false;
    void paintCurrent();return true;
  }
  async function show(blob,signal) {
    destroy();closed=false;const own=++generation;message(label("pdfLoading"));
    const current=()=>!closed&&own===generation&&!signal?.aborted;
    const abort=()=>destroy();signal?.addEventListener("abort",abort,{once:true});abortCleanup=()=>signal?.removeEventListener("abort",abort);
    const failed=()=>{if(!current())return;destroy();message(label("pdfFailed"));};
    const loadTimer=timeout(failed);
    try{
      if(signal?.aborted){destroy();return;}
      const lib=await loadLibrary();if(!current())return;lib.GlobalWorkerOptions.workerSrc="/vendor/pdfjs/pdf.worker.mjs";
      worker=new lib.PDFWorker();await worker.promise;if(!current())return;
      if(typeof Worker!=="undefined"&&!(worker.port instanceof Worker))throw new Error("PDF worker unavailable");
      const data=new Uint8Array(await blob.arrayBuffer());if(!current())return;
      loading=lib.getDocument({data,worker,cMapUrl:"/vendor/pdfjs/cmaps/",cMapPacked:true,standardFontDataUrl:"/vendor/pdfjs/standard_fonts/",useWorkerFetch:true,useWasm:false,enableXfa:false,disableFontFace:true,useSystemFonts:true,stopAtErrors:true,disableRange:true,disableStream:true,disableAutoFetch:true,maxImageSize:32000000,canvasMaxAreaInBytes:32000000,isOffscreenCanvasSupported:false,isImageDecoderSupported:false});
      // The loading task owns destruction; a late PDFDocumentProxy has no destroy alias.
      loading.onPassword=failed;const loaded=await loading.promise;if(!current())return;pdf=loaded;clearTimer(loadTimer);pageNumber=1;
      if(!Number.isSafeInteger(loaded.numPages)||loaded.numPages<1)throw new Error("Invalid PDF page count");
      const toolbar=node("div");toolbar.className="pdf-toolbar";toolbar.style.flexWrap="wrap";toolbar.style.justifyContent="flex-start";
      const previous=named("button","previousPage","이전 페이지"),next=named("button","nextPage","다음 페이지"),position=node("span");previous.textContent=label("previousPage","이전 페이지");next.textContent=label("nextPage","다음 페이지");previous.type=next.type="button";
      pageInput=named("input","pageNumber","PDF 페이지 번호");const input=pageInput;input.type="text";input.inputMode="numeric";input.style.width="3.5rem";input.setAttribute("aria-description",`1–${Math.min(loaded.numPages,200)}`);
      const zoomInput=named("input","zoomPercent","확대율 (%)");zoomInput.type="number";zoomInput.min="50";zoomInput.max="200";zoomInput.step="25";zoomInput.style.width="4rem";
      const minus=named("button","zoomOut","축소"),plus=named("button","zoomIn","확대"),fit=named("button","fitWidth","너비 맞춤");minus.type=plus.type=fit.type="button";minus.textContent="−";plus.textContent="+";fit.textContent=label("fitWidth","너비 맞춤");
      const feedback=node("p");feedback.className="files-status";feedback.setAttribute("role","status");feedback.setAttribute("aria-live","polite");
      const surface=node("div");surface.className="pdf-page-surface";Object.assign(surface.style,{overflow:"auto",maxHeight:"70vh"});
      toolbar.append(previous);
      if(features.F13!==false)toolbar.append(input);
      toolbar.append(position,next);
      if(features.F13!==false)toolbar.append(minus,zoomInput,node("span","%"),plus,fit);
      const staticNote=node("small",label("pdfStaticPreview","Print preview"));staticNote.className="files-status pdf-static-preview";
      container.replaceChildren(toolbar,staticNote,feedback,surface);
      function sync(){input.value=String(pageNumber);zoomInput.value=String(zoom);position.textContent=`${features.F13===false?`${pageNumber} `:""}/ ${Math.min(loaded.numPages,200)}${loaded.numPages>200?"+":""}`;previous.disabled=pageNumber<=1;next.disabled=pageNumber>=Math.min(loaded.numPages,200);minus.disabled=zoom<=50;plus.disabled=zoom>=200;fit.setAttribute("aria-pressed",String(fitWidth));}
      async function paint(){
        if(!current())return;const selected=++pageSequence,targetPage=pageNumber,targetZoom=zoom;cancelJob();rendering=true;sync();
        const latest=()=>current()&&selected===pageSequence;
        const job={page:null,task:null,timer:timeout(()=>{if(latest())failed();})};activeJob=job;surface.setAttribute("aria-busy","true");
        try{
          job.page=await loaded.getPage(targetPage);if(!latest())return;
          const base=job.page.getViewport({scale:1}),ratio=Math.min(2,Math.max(1,globalThis.devicePixelRatio||1)),size=boundedPdfViewport(base.width,base.height,Math.max(120,container.clientWidth-32),ratio,targetZoom);
          // Detached canvases prevent obsolete renders from altering the visible page.
          const canvas=node("canvas");canvas.className="pdf-canvas";canvas.dataset.page=String(targetPage);canvas.setAttribute("aria-label",`${label("pdfPage","PDF 페이지")} ${targetPage}`);canvas.width=size.width;canvas.height=size.height;
          Object.assign(canvas.style,{maxWidth:"none",maxHeight:"none",width:`${size.width/ratio}px`,height:`${size.height/ratio}px`});
          // Static print intent avoids display rendering's animation-frame scheduler.
          // Keep its visible semantic label above; this does not invoke browser printing.
          job.task=job.page.render({canvas,canvasContext:canvas.getContext("2d"),viewport:job.page.getViewport({scale:size.scale}),intent:"print",annotationMode:lib.AnnotationMode.DISABLE});await job.task.promise;
          if(!latest())return;surface.replaceChildren(canvas);limited=size.limited;feedback.textContent=limited?label("pdfResolutionLimit","미리보기 해상도 상한에 도달했습니다 (8M pixels / 8192px)"):"";
        }catch(error){if(latest()&&error.name!=="RenderingCancelledException")failed();}
        finally{clearTimer(job.timer);job.page?.cleanup();if(activeJob===job)activeJob=null;if(latest()){rendering=false;surface.removeAttribute("aria-busy");}}
      }
      paintCurrent=paint;
      const submitPage=()=>{if(!current())return;const value=input.value.trim(),page=/^[1-9]\d*$/.test(value)?Number(value):NaN;if(!setView({page})){input.setAttribute("aria-invalid","true");feedback.textContent=`1–${Math.min(loaded.numPages,200)} ${label("validPageRange","범위의 페이지 번호를 입력하세요")}`;}else input.removeAttribute("aria-invalid");};
      const submitZoom=()=>{if(!current())return;const value=zoomInput.value.trim(),amount=value?Number(value):NaN;if(!setView({zoom:amount})){zoomInput.setAttribute("aria-invalid","true");feedback.textContent=label("validZoomRange","확대율은 50–200% 범위로 입력하세요");}else zoomInput.removeAttribute("aria-invalid");};
      const enter=handler=>event=>{if(event.key!=="Enter"||event.isComposing||event.keyCode===229)return;event.preventDefault();handler();};
      listen(previous,"click",()=>setView({page:pageNumber-1}));listen(next,"click",()=>setView({page:pageNumber+1}));
      if(features.F13!==false){
      listen(input,"keydown",enter(submitPage));listen(input,"change",submitPage);listen(zoomInput,"keydown",enter(submitZoom));listen(zoomInput,"change",submitZoom);
      listen(minus,"click",()=>setView({zoom:Math.max(50,zoom-25)}));listen(plus,"click",()=>setView({zoom:Math.min(200,zoom+25)}));
      listen(fit,"click",()=>{if(!current())return;zoom=100;fitWidth=true;void paint();});
      }
      if(typeof globalThis.ResizeObserver==="function"){
        let width=container.clientWidth;resizeObserver=new globalThis.ResizeObserver(()=>{if(width===container.clientWidth)return;width=container.clientWidth;clearTimeout(resizeTimer);if(fitWidth&&current())resizeTimer=setTimeout(()=>{if(current()&&fitWidth)void paint();},60);});resizeObserver.observe(container);
      }
      await paint();
    }catch{failed();}
  }
  return {
    show,destroy,setView:value=>features.F13!==false&&setView(value),
    getState(){return closed||!pdf?null:{page:pageNumber,pageCount:Math.min(pdf.numPages,200),zoom,fitWidth,limited,rendering};},
    focusPage(){if(closed||!pageInput||features.F13===false)return false;pageInput.focus();return true;}
  };
}
