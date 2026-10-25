// The theme script both root documents (app/layout.tsx and app/global-error.tsx)
// inline in <head>, applied before paint so there is no light/dark flash on
// load: the remembered choice, dark unless light was picked. Plain string, no
// React, so a server layout and a client error boundary can share it.
export const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem("theme");if(t!=="light"){document.documentElement.classList.add("dark")}}catch(e){document.documentElement.classList.add("dark")}})()`;
