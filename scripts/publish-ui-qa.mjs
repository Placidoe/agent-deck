// Actual conversion + actual UI; memory clipboard and labelled publisher receipt.
// No live clipboard, browser login, model calls or external publishing.
import { _electron as electron } from "playwright";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const output=path.join(root,"qa/themes/publish");fs.mkdirSync(output,{recursive:true});
const env={...process.env,AGENT_DECK_REVIEW_QA:"1",AGENT_DECK_PUBLISH_QA:"1"};delete env.ELECTRON_RUN_AS_NODE;
const app=await electron.launch({executablePath:path.resolve(root,"../research/labs/grokbot-desktop/node_modules/.bin/electron"),args:[path.join(root,"scripts/design-qa-main.cjs")],env});
const report={source:"Disposable labelled review artifact, actual conversion/renderer; memory clipboard, publisher transport fixture; no external publication",checks:[],errors:[]};
try {
 const page=await app.firstWindow();page.on("pageerror",e=>report.errors.push(e.message));
 const nav=page.getByRole("navigation",{name:"主导航"});
 for(const [mode,label] of [["light","浅色"],["dark","深色"]]){
  await page.getByRole("button",{name:"设置",exact:true}).click();await page.getByRole("radio",{name:label,exact:true}).check();
  await nav.getByRole("button",{name:"成果",exact:true}).click();
  await page.getByRole("button",{name:"刷新成果",exact:true}).click();
  await page.getByRole("status").getByText("已重新读取成果目录。",{exact:true}).waitFor();
  await page.locator(".library-filename").filter({hasText:"reference.html"}).first().click();
  await page.getByRole("button",{name:"分享发布",exact:true}).click();
  const dialog=page.getByRole("dialog",{name:"生成并发布社区文章",exact:true});
  await dialog.getByRole("textbox",{name:"发布稿（只读）"}).waitFor();
  assert.equal(await dialog.locator("select").count(),0,"custom selects, not OS default controls");
  assert.equal(await dialog.getByRole("button",{name:"登录并填入发布页",exact:true}).count(),1,"one primary fill action");
  await dialog.getByRole("button",{name:"复制稿件",exact:true}).click();
  await dialog.getByRole("status").filter({hasText:"已复制"}).waitFor();
  assert.ok((await app.evaluate(()=>globalThis.publishQa.clipboard.at(-1))).length>0);
  await dialog.getByRole("button",{name:"登录并填入发布页",exact:true}).click();
  await dialog.getByRole("status").filter({hasText:"请在发布窗口完成首次登录"}).waitFor();
  assert.equal((await app.evaluate(()=>globalThis.publishQa.publish.at(-1))).autoPublish,false);
  for(const [w,h] of [[1540,960],[1120,720]]){
   await app.evaluate(({BrowserWindow},size)=>BrowserWindow.getAllWindows()[0].setContentSize(...size),[w,h]);
   await page.screenshot({path:path.join(output,`${mode}-${w}.png`)});
   const r=await dialog.boundingBox();assert.ok(r.x>=0&&r.y>=0&&r.x+r.width<=w+1&&r.y+r.height<=h+1);
   const geometry=await dialog.evaluate(el=>{
    const bounds=el.getBoundingClientRect(), text=el.querySelector('.publish-content').getBoundingClientRect(), checkbox=el.querySelector('input[type=checkbox]').getBoundingClientRect(), footer=el.querySelector('footer').getBoundingClientRect();
    return {textInside:text.left>=bounds.left&&text.right<=bounds.right,checkboxWidth:checkbox.width,checkboxHeight:checkbox.height,footerVisible:footer.bottom<=bounds.bottom+1&&footer.top>=bounds.top};
   });
   assert.ok(geometry.textInside,'稿件不能溢出弹窗');
   assert.equal(geometry.checkboxWidth,16);assert.equal(geometry.checkboxHeight,16);
   assert.ok(geometry.footerVisible,'窄窗口操作栏始终可见');
   report.checks.push({mode,w,h,visibleFeedback:true});
  }
  // Failed conversion cannot expose the previously converted platform's draft.
  await app.evaluate(()=>{globalThis.publishQa.failConversion=true;});
  await dialog.getByRole("combobox",{name:"发布平台"}).click();await page.getByRole("option",{name:"CSDN",exact:true}).click();
  await dialog.getByRole("alert").filter({hasText:"转换失败"}).waitFor();
  assert.equal(await dialog.getByRole("textbox",{name:"发布稿（只读）"}).count(),0);
  assert.equal(await dialog.getByRole("button",{name:"登录并填入发布页",exact:true}).isEnabled(),false);
  await app.evaluate(()=>{globalThis.publishQa.failConversion=false;});
  await dialog.getByRole("button",{name:"重新转换",exact:true}).click();
  await dialog.getByRole("textbox",{name:"发布稿（只读）"}).waitFor();
  await page.keyboard.press("Escape");await dialog.waitFor({state:"detached"});
  await page.getByRole("button",{name:"关闭预览",exact:true}).click();
 }
 assert.deepEqual(report.errors,[]);
}finally{fs.writeFileSync(path.join(output,"report.json"),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));await app.close();}
