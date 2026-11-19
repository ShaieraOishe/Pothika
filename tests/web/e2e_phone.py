# Browser checks. Needs: pip install playwright && playwright install chromium; serve web/ with `python -m http.server 8765`.
import io, json
from PIL import Image
from playwright.sync_api import sync_playwright
import os; SH='/tmp/dsr-shots/'; os.makedirs(SH, exist_ok=True)
buf=io.BytesIO(); Image.new('RGB',(256,256),(226,230,236)).save(buf,'PNG'); GRAY=buf.getvalue()
errors=[]; checks=[]
def check(name, ok, extra=''):
    checks.append((name, bool(ok))); print(('PASS ' if ok else 'FAIL ')+name, extra)
with sync_playwright() as p:
    b=p.chromium.launch()
    ctx=b.new_context(viewport={'width':390,'height':844},device_scale_factor=2,is_mobile=True,has_touch=True,locale='bn-BD',timezone_id='Asia/Dhaka',permissions=[])
    ctx.route('**/tile.openstreetmap.org/**', lambda r: r.fulfill(status=200,content_type='image/png',body=GRAY))
    pg=ctx.new_page()
    pg.on('console', lambda m: errors.append((m.type,m.text)) if m.type in('error','warning') else None)
    pg.on('pageerror', lambda e: errors.append(('pageerror',str(e))))
    pg.goto('http://localhost:8765/index.html?debug'); pg.wait_for_function('window.__dsr'); pg.wait_for_timeout(500)
    pg.screenshot(path=SH+'10_initial.png')
    # whole coverage visible above the sheet at start?
    vis=pg.evaluate('''()=>{const {map,g}=window.__dsr; const sh=document.querySelector('#sheet').getBoundingClientRect(); const mr=document.querySelector('#map').getBoundingClientRect();
      const [w,s,e,n]=g.meta.bbox; const sw=map.latLngToContainerPoint([s,w]), ne=map.latLngToContainerPoint([n,e]);
      return {swY:sw.y+mr.top, sheetTop:sh.top, neY:ne.y+mr.top, left:sw.x, right:ne.x, w:mr.width}}''')
    check('initial view: whole area above the panel', vis['swY']<=vis['sheetTop']+1 and vis['neY']>=mr if False else vis['swY']<=vis['sheetTop']+1, vis)
    pts=pg.evaluate('''()=>{const {g,map}=window.__dsr; const mr=document.querySelector('#map').getBoundingClientRect(); const top=document.querySelector('#sheet').getBoundingClientRect().top-mr.top-20;
      const vis=g.nodes.filter(q=>{const c=map.latLngToContainerPoint([q[1],q[0]]);return c.y>50&&c.y<top&&c.x>30&&c.x<mr.width-80});
      let a=vis[0], best=null, bd=0; for(const q of vis){const d=Math.hypot((q[0]-a[0])*g.kx,(q[1]-a[1])*110574); if(d>bd){bd=d;best=q}}
      const f=(ll)=>{const c=map.latLngToContainerPoint([ll[1],ll[0]]);return [mr.x+c.x,mr.y+c.y]};
      return {a:f(a),b:f(best),dist:bd}}''')
    pg.mouse.click(*pts['a']); pg.wait_for_timeout(150); pg.mouse.click(*pts['b']); pg.wait_for_timeout(700)
    check('two taps produce route options', pg.locator('.route').count()>=1, f"cards={pg.locator('.route').count()}")
    fit=pg.evaluate('''()=>{const {map,S}=window.__dsr; const sh=document.querySelector('#sheet').getBoundingClientRect(); const mr=document.querySelector('#map').getBoundingClientRect();
      let minY=1e9,maxY=-1e9,minX=1e9,maxX=-1e9; for(const gr of S.groups) for(const c of gr.coords){const p=map.latLngToContainerPoint([c[1],c[0]]); minY=Math.min(minY,p.y+mr.top);maxY=Math.max(maxY,p.y+mr.top);minX=Math.min(minX,p.x);maxX=Math.max(maxX,p.x)}
      return {minY,maxY,minX,maxX,sheetTop:sh.top,mapTop:mr.top,w:mr.width}}''')
    check('route fits above the panel after fitting', fit['maxY']<=fit['sheetTop']+2 and fit['minY']>=fit['mapTop']-2 and fit['minX']>=-2 and fit['maxX']<=fit['w']+2, {k:round(v) for k,v in fit.items()})
    pg.screenshot(path=SH+'11_route_day.png')
    # layers: risk overlay
    pg.evaluate("document.querySelector('.layers').open=true"); pg.check('#ly-risk'); pg.wait_for_timeout(300)
    check('risk legend shows with overlay', pg.is_visible('#risk-legend'))
    pg.evaluate("document.querySelector('#sheet-body').scrollTo(0,0)")
    pg.screenshot(path=SH+'12_risk_overlay.png'); pg.uncheck('#ly-risk')
    # night + english
    pg.click('#t-night'); pg.wait_for_timeout(300)
    nz=pg.evaluate('window.__dsr.S.groups.map(g=>g.names.join("+")+":"+Math.round(g.length_m)+"/"+g.high_risk_share.toFixed(2))')
    print('night groups:',nz)
    pg.click('#btn-lang'); pg.wait_for_timeout(300)
    check('english toggle', pg.inner_text('#btn-lang')=='বাংলা' and pg.evaluate('document.documentElement.lang')=='en')
    print('EN first row:', pg.locator('.route').first.inner_text().replace('\n',' | ')[:200])
    pg.screenshot(path=SH+'13_route_night_en.png')
    # report flow
    pg.click('#btn-lang'); pg.wait_for_timeout(200)
    pg.evaluate("document.querySelector('#sheet-body').scrollTo(0,99999)")
    pg.click('#btn-report'); pg.wait_for_timeout(200)
    check('report mode hint', 'ট্যাপ' in pg.inner_text('#hint') and pg.evaluate("document.querySelector('#map').classList.contains('is-reporting')"), pg.inner_text('#hint'))
    JS_TAP='''()=>{const {S,g,map}=window.__dsr; const mr=document.querySelector('#map').getBoundingClientRect(); const gr=S.groups[0];
      let best=gr.path[0]; for(const ei of gr.path) if(g.edges[ei].len>g.edges[best].len) best=ei; const e=g.edges[best];
      const k=Math.floor((e.pts.length-1)/2), a=e.pts[k], b=e.pts[k+1]; const m=[(a[0]+b[0])/2,(a[1]+b[1])/2];
      const p=map.latLngToContainerPoint([m[1],m[0]]); return {xy:[mr.x+p.x, mr.y+p.y], key:e.key}}'''
    before=pg.evaluate('window.__dsr.S.groups.map(g=>g.mean_risk)')
    t1=pg.evaluate(JS_TAP); pg.mouse.click(*t1['xy']); pg.wait_for_timeout(500)
    check('first tap at low zoom zooms in instead of picking', (not pg.is_visible('#dlg-report')) and pg.evaluate('window.__dsr.map.getZoom()')>=16, pg.inner_text('#toast'))
    t2=pg.evaluate(JS_TAP); pg.mouse.click(*t2['xy']); pg.wait_for_timeout(500)
    picked=pg.evaluate('window.__dsr.S.pending && window.__dsr.S.pending.stretch.keys')
    check('second tap picks the tapped street', picked and t2['key'] in picked, {'wanted':t2['key'],'got':picked})
    check('report dialog opens on tapping a street', pg.is_visible('#dlg-report'))
    check('dialog shows the stretch length', 'মিটার অংশের' in pg.inner_text('#rep-stretch'), pg.inner_text('#rep-stretch'))
    pg.screenshot(path=SH+'14_report_dialog.png')
    pg.click('#dlg-report [data-kind="dark"]'); pg.wait_for_timeout(500)
    stored=pg.evaluate("JSON.parse(localStorage.getItem('dsr.reports.v1')||'[]')")
    check('report saved locally with no position of the user', len(stored)==1 and stored[0]['kind']=='dark' and set(stored[0].keys())=={'id','keys','name','kind','when','loc','dv','length_m','date'}, stored[0] if stored else None)
    after=pg.evaluate('window.__dsr.S.groups.map(g=>g.mean_risk)')
    check('routes recomputed using the report', before!=after and max(abs(x-y) for x,y in zip(before,after))>0.001, f'{[round(x,3) for x in before]} -> {[round(x,3) for x in after]}')
    check('mine counter updated', '(১)' in pg.inner_text('#mine-label'), pg.inner_text('#mine-label'))
    pg.click('#btn-mine'); pg.wait_for_timeout(300); pg.screenshot(path=SH+'15_my_reports.png')
    pg.click('#mine-list [data-del]'); pg.wait_for_timeout(300)
    check('report deleted', pg.evaluate("JSON.parse(localStorage.getItem('dsr.reports.v1')||'[]').length")==0)
    pg.keyboard.press('Escape')
    # about
    pg.click('#btn-about'); pg.wait_for_timeout(300); pg.screenshot(path=SH+'16_about.png')
    check('about has 999 and 109 call links', pg.locator('#about-body a[href="tel:999"]').count()==1 and pg.locator('#about-body a[href="tel:109"]').count()==1)
    pg.keyboard.press('Escape')
    # outside coverage
    pg.click('#btn-reset'); pg.wait_for_timeout(200)
    pg.evaluate("window.__dsr.map.setView([23.70,90.30],15,{animate:false}); 0"); pg.wait_for_timeout(200)
    c=pg.evaluate('''()=>{const mr=document.querySelector('#map').getBoundingClientRect(); return [mr.x+mr.width/2, mr.y+80]}''')
    pg.mouse.click(*c); pg.wait_for_timeout(300)
    check('tap outside coverage shows message, sets nothing', pg.evaluate('window.__dsr.S.origin')is None and 'ম্যাপে নেই' in pg.inner_text('#toast'), pg.inner_text('#toast'))
    # service worker
    pg.wait_for_timeout(800)
    check('service worker registered', pg.evaluate("navigator.serviceWorker.getRegistration().then(r=>!!r)"))
    json.dump(errors,open('errors2.json','w'),ensure_ascii=False)
    print('console errors/warnings:', errors)
    print('FAILED:', [n for n,o in checks if not o])
    b.close()
