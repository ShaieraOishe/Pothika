# Browser checks. Needs: pip install playwright && playwright install chromium; serve web/ with `python -m http.server 8765`.
import io, json
from PIL import Image
from playwright.sync_api import sync_playwright
import os; SH='/tmp/dsr-shots/'; os.makedirs(SH, exist_ok=True)
buf=io.BytesIO(); Image.new('RGB',(256,256),(226,230,236)).save(buf,'PNG'); GRAY=buf.getvalue()
checks=[]; errors=[]
def check(n,ok,extra=''): checks.append((n,bool(ok))); print(('PASS ' if ok else 'FAIL ')+n, extra)
with sync_playwright() as p:
    b=p.chromium.launch()
    # ---- desktop layout
    ctx=b.new_context(viewport={'width':1280,'height':800},device_scale_factor=1,locale='bn-BD')
    ctx.route('**/tile.openstreetmap.org/**', lambda r: r.fulfill(status=200,content_type='image/png',body=GRAY))
    pg=ctx.new_page(); pg.on('console', lambda m: errors.append((m.type,m.text)) if m.type in('error','warning') else None); pg.on('pageerror', lambda e: errors.append(('pageerror',str(e))))
    pg.goto('http://localhost:8765/index.html?debug'); pg.wait_for_function('window.__dsr'); pg.wait_for_timeout(500)
    lay=pg.evaluate('''()=>{const s=document.querySelector('#sheet').getBoundingClientRect(), m=document.querySelector('#map').getBoundingClientRect(); return {sheetW:s.width,sheetLeft:s.left,mapLeft:m.left,mapW:m.width,handleShown:getComputedStyle(document.querySelector('#btn-sheet')).display}}''')
    check('desktop: side panel left, map right', lay['sheetLeft']==0 and abs(lay['mapLeft']-lay['sheetW'])<2 and lay['handleShown']=='none', lay)
    pts=pg.evaluate('''()=>{const {g,map}=window.__dsr; const mr=document.querySelector('#map').getBoundingClientRect();
      const vis=g.nodes.filter(q=>{const c=map.latLngToContainerPoint([q[1],q[0]]);return c.y>50&&c.y<mr.height-30&&c.x>30&&c.x<mr.width-80});
      let a=vis[0], best=null, bd=0; for(const q of vis){const d=Math.hypot((q[0]-a[0])*g.kx,(q[1]-a[1])*110574); if(d>bd){bd=d;best=q}}
      const f=(ll)=>{const c=map.latLngToContainerPoint([ll[1],ll[0]]);return [mr.x+c.x,mr.y+c.y]}; return {a:f(a),b:f(best)}}''')
    pg.mouse.click(*pts['a']); pg.wait_for_timeout(150); pg.mouse.click(*pts['b']); pg.wait_for_timeout(600)
    check('desktop: routes appear', pg.locator('.route').count()>=1)
    pg.screenshot(path=SH+'20_desktop.png')
    ctx.close()
    # ---- small phone (320 wide) no horizontal overflow, big text
    ctx=b.new_context(viewport={'width':320,'height':640},device_scale_factor=2,is_mobile=True,has_touch=True,locale='bn-BD')
    ctx.route('**/tile.openstreetmap.org/**', lambda r: r.fulfill(status=200,content_type='image/png',body=GRAY))
    pg=ctx.new_page(); pg.goto('http://localhost:8765/index.html?debug'); pg.wait_for_function('window.__dsr'); pg.wait_for_timeout(500)
    ov=pg.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth')
    check('320px phone: no horizontal scroll', ov<=0, ov); pg.screenshot(path=SH+'21_small_phone.png')
    ctx.close()
    # ---- offline after first visit
    ctx=b.new_context(viewport={'width':390,'height':844},is_mobile=True,locale='bn-BD')
    ctx.route('**/tile.openstreetmap.org/**', lambda r: r.fulfill(status=200,content_type='image/png',body=GRAY))
    pg=ctx.new_page(); pg.goto('http://localhost:8765/index.html'); pg.wait_for_timeout(1500)
    pg.evaluate("navigator.serviceWorker.ready.then(()=>1)"); pg.wait_for_timeout(1500)
    cached=pg.evaluate("caches.open('dsr-v4').then(c=>c.keys()).then(k=>k.map(r=>new URL(r.url).pathname))")
    check('service worker cached the app files', all(x in cached for x in ['/data/area.json','/js/app.js','/style.css','/fonts/anek-bangla.woff2']), len(cached))
    ctx.set_offline(True)
    pg.goto('http://localhost:8765/index.html?debug'); pg.wait_for_function('window.__dsr', timeout=8000); pg.wait_for_timeout(600)
    check('offline: app and street data still load', pg.evaluate('window.__dsr.g.edges.length')==4608 and 'শুরুর জায়গা' in pg.inner_text('#hint'))
    ctx.close()
    # ---- english default? lang persists
    ctx=b.new_context(viewport={'width':390,'height':844},is_mobile=True,locale='bn-BD')
    ctx.route('**/tile.openstreetmap.org/**', lambda r: r.fulfill(status=200,content_type='image/png',body=GRAY))
    pg=ctx.new_page(); pg.goto('http://localhost:8765/index.html'); pg.wait_for_timeout(500)
    pg.click('#btn-lang'); pg.reload(); pg.wait_for_timeout(600)
    check('language choice persists', pg.evaluate('document.documentElement.lang')=='en')
    # blocked storage must not break the app
    ctx.close()
    ctx=b.new_context(viewport={'width':390,'height':844},is_mobile=True)
    ctx.add_init_script("Object.defineProperty(window,'localStorage',{get(){throw new Error('blocked')}})")
    ctx.route('**/tile.openstreetmap.org/**', lambda r: r.fulfill(status=200,content_type='image/png',body=GRAY))
    pg=ctx.new_page(); pg.on('pageerror', lambda e: errors.append(('pageerror-blocked',str(e)))); pg.goto('http://localhost:8765/index.html?debug'); pg.wait_for_function('window.__dsr',timeout=8000)
    check('app works when browser storage is blocked', pg.evaluate("window.__dsr.S.state")=='ready')
    ctx.close()
    # ---- data fetch failure shows a message
    ctx=b.new_context(viewport={'width':390,'height':844},is_mobile=True,locale='bn-BD', service_workers='block')
    ctx.route('**/data/area.json', lambda r: r.abort())
    pg=ctx.new_page(); pg.goto('http://localhost:8765/index.html'); pg.wait_for_timeout(800)
    check('data load failure is explained', 'লোড করা যায়নি' in pg.inner_text('#hint'), pg.inner_text('#hint'))
    ctx.close()
    print('console/page errors:', errors); print('FAILED:',[n for n,o in checks if not o]); b.close()
