// The theme script both root documents (app/layout.tsx and app/global-error.tsx)
// inline in <head>, applied before paint so there is no light/dark flash on
// load: the remembered choice, dark unless light was picked. Plain string, no
// React, so a server layout and a client error boundary can share it.
export const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem("theme");if(t!=="light"){document.documentElement.classList.add("dark")}}catch(e){document.documentElement.classList.add("dark")}})()`;

// The opening splash (components/AiSplash.tsx) plays once when the app is
// opened: this hides it before paint when this tab has played it already, or
// any tab did in the last few minutes (opening a few tabs at once, a printout).
// Kept in step with SPLASH_KEY / SPLASH_AGAIN_MS there.
export const SPLASH_INIT_SCRIPT = `(function(){try{var s=sessionStorage.getItem("ai-splash"),l=Number(localStorage.getItem("ai-splash"))||0;if(s||Date.now()-l<600000){document.documentElement.dataset.splash="off"}}catch(e){document.documentElement.dataset.splash="off"}})()`;
