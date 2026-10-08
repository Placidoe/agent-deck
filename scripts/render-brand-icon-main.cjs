const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const profile = fs.mkdtempSync(path.join(os.tmpdir(),"agent-deck-icon-"));
app.setPath("userData",profile);
app.on("window-all-closed",()=>app.quit());
app.on("quit",()=>fs.rmSync(profile,{recursive:true,force:true}));
app.whenReady().then(async()=>{
  const window = new BrowserWindow({ width:1024,height:1024,useContentSize:true,frame:false,transparent:true,show:false, webPreferences:{nodeIntegration:false,contextIsolation:true} });
  const svg = fs.readFileSync(path.join(__dirname,"../public/brand-icon.svg"),"utf8");
  await window.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(`<html><body style="margin:0;width:1024px;height:1024px;background:transparent">${svg}</body></html>`));
});
