// Read-only real ledger copy. No model, executor, notifications or production writes.
import { _electron as electron } from "playwright";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { THEMES } from "../src/appearance.js";
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const output = path.join(root,"qa/appearance"); fs.mkdirSync(output,{recursive:true});
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ executablePath:path.resolve(root,"../research/labs/grokbot-desktop/node_modules/.bin/electron"),args:[path.join(root,"scripts/design-qa-main.cjs")],env });
const report = { source:"Disposable real-ledger copy, actual renderer. No executor.",checks:[],errors:[] };
try {
  const page = await app.firstWindow(); page.on("pageerror",error=>report.errors.push(error.message));
  const nav = page.getByRole("navigation",{name:"主导航"});
  for (const [w,h] of [[1540,960],[1120,720]]) {
    await app.evaluate(({ BrowserWindow },size)=>BrowserWindow.getAllWindows()[0].setContentSize(...size),[w,h]);
    const semantic = await page.evaluate(()=>["--green","--amber","--red"].map(key=>getComputedStyle(document.documentElement).getPropertyValue(key)));
    for (const theme of THEMES) {
      await page.getByRole("button",{name:"设置",exact:true}).click();
      await page.getByRole("radio",{name:theme.name,exact:true}).check();
      assert.equal(await page.evaluate(()=>document.documentElement.dataset.accentTheme),theme.id);
      assert.deepEqual(await page.evaluate(()=>["--green","--amber","--red"].map(key=>getComputedStyle(document.documentElement).getPropertyValue(key))),semantic);
      assert.equal(await page.locator(".appearance-preview .agent-identity-avatar.main").evaluate(element=>getComputedStyle(element).display),"grid");
      await capture(`settings-${theme.id}-${w}`);
      await nav.getByRole("button",{name:"工作",exact:true}).click();
      await page.locator(".requirement-detail .primary-next").waitFor();
      const actual = await page.locator(".new-requirement").evaluate(element=>getComputedStyle(element).backgroundColor);
      assert.equal(actual,rgb(theme.solid),`${theme.id} must replace legacy button blue after lazy loading`);
      await capture(`work-${theme.id}-${w}`);
    }
    await page.getByRole("button",{name:"设置",exact:true}).click();
    const blue = page.getByRole("radio",{name:"雾蓝",exact:true});
    await blue.check(); await blue.focus(); await blue.press("ArrowRight");
    await page.waitForFunction(()=>document.documentElement.dataset.accentTheme === "iris");
    assert.equal(await page.getByRole("radio",{name:"鸢尾",exact:true}).isChecked(),true);
    await page.reload();
    await page.locator(".requirement-detail .primary-next").waitFor();
    assert.equal(await page.evaluate(()=>document.documentElement.dataset.accentTheme),"iris","theme survives reload");
    await page.locator(".primary-next").click();
    await page.locator(".graph-viewport").waitFor();
    assert.equal(await page.locator(".product-symbol").evaluate(e=>getComputedStyle(e).color),rgb(THEMES[1].accent));
    await capture(`execution-iris-${w}`);
    const control = page.locator(".graph-toolbar .select-control").first();
    await control.click(); await page.locator(".select-menu").waitFor();
    const menu = await page.locator(".select-menu").boundingBox();
    assert.ok(menu.x>=0 && menu.x+menu.width<=w && menu.y>=0 && menu.y+menu.height<=h,"custom menu remains within window");
    assert.equal(await page.locator('.select-menu button[aria-selected="true"]').evaluate(e=>getComputedStyle(e).color),rgb(THEMES[1].accent));
    await capture(`menu-iris-${w}`); await control.press("Escape");
    await nav.getByRole("button",{name:/待我处理/}).click();
    await page.getByRole("button",{name:"逐项处理",exact:true}).click();
    assert.equal(await page.locator(".focus-open").evaluate(e=>getComputedStyle(e).backgroundColor),rgb(THEMES[1].solid));
    assert.equal(await page.locator(".focus-owner>.agent-identity-avatar").evaluate(e=>getComputedStyle(e).display),"grid","lazy focus-owner styles must not break the avatar");
    await capture(`attention-iris-${w}`);
    await nav.getByRole("button",{name:"成果",exact:true}).click();
    await page.locator(".library-file-row").first().waitFor();
    await capture(`results-iris-${w}`);
  }
  assert.deepEqual(report.errors,[]);
  assert.ok(report.checks.every(item=>!item.failures.length));
  async function capture(name) {
    await page.screenshot({path:path.join(output,name+".png")});
    report.checks.push(await page.evaluate(name=>{
      const failures=[];
      if(document.documentElement.scrollWidth>innerWidth) failures.push("root overflow");
      for(const selector of [".work-navigation",".mission-toolbar",".mission-inspector",".agent-compose",".appearance-preview",".theme-options"]) {
        const e=document.querySelector(selector); if(!e?.getClientRects().length) continue;
        const r=e.getBoundingClientRect(); if(r.right>innerWidth+1) failures.push(selector+" horizontal clipping");
      }
      return {name,width:innerWidth,height:innerHeight,failures};
    },name));
  }
} finally {
  fs.writeFileSync(path.join(output,"report.json"),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2)); await app.close();
}
function rgb(hex) { return `rgb(${hex.slice(1).match(/../g).map(n=>parseInt(n,16)).join(", ")})`; }
