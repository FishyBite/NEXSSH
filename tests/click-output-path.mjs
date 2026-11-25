export async function clickOutputPath(page, sessionId, fragment, modified) {
  const origin = await page.waitForFunction(({sessionId, fragment})=>{
    const host = document.querySelector('.terminal-pane[data-session-id="'+sessionId+'"] .xterm-rows');
    if (!host) return null;
    for (const row of host.children) {
      const text = row.textContent.replaceAll("\u00a0"," ");
      const offset = text.indexOf(fragment);
      if (offset<0) continue;
      let left = offset + 1;
      const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (node.length <= left) {left -= node.length; continue;}
        const range = new Range();
        range.setStart(node,left);
        range.setEnd(node,left+1);
        const rect = range.getBoundingClientRect();
        if (rect.width && rect.height) return {x:rect.x+rect.width/2,y:rect.y+rect.height/2};
      }
    }
    return null;
  }, {sessionId,fragment}, {timeout:6000});
  const {x,y} = await origin.jsonValue();
  await origin.dispose();
  if (modified) await page.keyboard.down("Control");
  try {
    await page.mouse.move(x-12,y);
    await page.mouse.move(x,y);
    await page.mouse.click(x,y);
  }
  finally { if (modified) await page.keyboard.up("Control"); }
}
