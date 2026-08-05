(()=>{
  const STORAGE_KEY="yumirume.appNav.scrollLeft";

  function readStoredPosition(){
    try{
      const value=Number(sessionStorage.getItem(STORAGE_KEY));
      return Number.isFinite(value)&&value>=0?value:null;
    }catch(_error){
      return null;
    }
  }

  function initAppNavigation(){
    const nav=document.querySelector(".app-shell-header .app-nav");
    if(!nav)return;
    let saveFrame=0;
    const savePosition=()=>{
      try{sessionStorage.setItem(STORAGE_KEY,String(Math.round(nav.scrollLeft)))}catch(_error){}
    };
    const scheduleSave=()=>{
      if(saveFrame)cancelAnimationFrame(saveFrame);
      saveFrame=requestAnimationFrame(()=>{
        saveFrame=0;
        savePosition();
      });
    };

    nav.addEventListener("scroll",scheduleSave,{passive:true});
    nav.addEventListener("click",event=>{
      if(event.target.closest(".app-nav-link"))savePosition();
    });
    window.addEventListener("pagehide",savePosition);

    requestAnimationFrame(()=>requestAnimationFrame(()=>{
      const storedPosition=readStoredPosition();
      if(storedPosition!==null){
        nav.scrollLeft=storedPosition;
        return;
      }
      nav.querySelector(".app-nav-link.active")?.scrollIntoView({block:"nearest",inline:"nearest"});
    }));
  }

  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",initAppNavigation,{once:true});
  else initAppNavigation();
})();
