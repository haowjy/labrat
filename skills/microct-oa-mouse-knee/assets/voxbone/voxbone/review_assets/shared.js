/* voxbone review site — shared logic across index/femur/tibia pages.
   Review state (verdicts, notes, edited landmarks) persists in localStorage
   keyed by sample_id, so navigating between pages keeps everything connected. */
const BM = {
  COL:{femur:[192,57,43],tibia:[36,113,163],
    condyle_lateral:[26,188,156],condyle_medial:[230,126,34],
    intercondylar_notch:[231,76,60],intercondylar_groove:[142,68,173],
    tibial_condyle_lateral:[26,188,156],tibial_condyle_medial:[230,126,34]},
  meta:null, key:null,
  async loadMeta(){ if(BM.meta) return BM.meta;
    BM.meta=window.BM_META;   // loaded via <script src="data/meta.js">
    BM.key='bmreview_'+BM.meta.sample_id; return BM.meta; },
  state(){ try{return JSON.parse(localStorage.getItem(BM.key))||{}}catch(e){return {}} },
  save(s){ localStorage.setItem(BM.key, JSON.stringify(s)); },
  patch(p){ const s=BM.state(); Object.assign(s,p); BM.save(s); },
  initTheme(){ const b=document.getElementById('themeBtn'); if(!b) return;
    const cur=localStorage.getItem('bm_theme');
    if(cur==='dark'){document.documentElement.classList.add('dark');b.textContent='☀';}
    b.onclick=()=>{ const d=document.documentElement.classList.toggle('dark');
      b.textContent=d?'☀':'🌙'; localStorage.setItem('bm_theme',d?'dark':'light');
      if(window.BM3D&&window.BM3D.retheme) window.BM3D.retheme(); }; },
  rgb(name){ return 'rgb('+(BM.COL[name]||[255,200,0]).join(',')+')'; }
};

/* ---------- 3D scene (index page) ---------- */
window.BM3D={};
BM3D.build=async function(elt){
  const M=window.BM_MESHES;   // loaded via <script src="data/meshes.js">
  const meta=await BM.loadMeta();
  function mt(m,name,color,op){return {type:'mesh3d',x:m.x,y:m.y,z:m.z,i:m.i,j:m.j,k:m.k,
    color:color,opacity:op,name:name,flatshading:true,hoverinfo:'name',showlegend:true,
    lighting:{ambient:.6,diffuse:.7}};}
  const L=meta.landmarks;
  const byName={}; L.forEach(l=>byName[l.name]=l);
  function dist(a,b){return Math.sqrt((a.mx-b.mx)**2+(a.my-b.my)**2+(a.mz-b.mz)**2);}
  // measurement line traces: how each index was measured (paper definitions)
  const MEAS=[
    {a:'condyle_lateral',b:'condyle_medial',label:'Femur width',col:'#e67e22'},
    {a:'intercondylar_notch',b:'intercondylar_groove',label:'Femur length',col:'#8e44ad'},
    {a:'tibial_condyle_lateral',b:'tibial_condyle_medial',label:'Tibia width',col:'#16a085'}];
  const lineTraces=MEAS.filter(m=>byName[m.a]&&byName[m.b]).map(m=>{
    const A=byName[m.a],B=byName[m.b],d=dist(A,B);
    return {type:'scatter3d',mode:'lines+text',name:m.label+' ('+d.toFixed(2)+' mm)',
      x:[A.mx,B.mx],y:[A.my,B.my],z:[A.mz,B.mz],
      line:{color:m.col,width:6},
      text:['', m.label+': '+d.toFixed(2)+' mm'],textposition:'middle center',
      textfont:{color:m.col,size:11},hoverinfo:'name'};});
  const traces=[mt(M.femur,'Femur','rgb(192,57,43)',.35),mt(M.tibia,'Tibia','rgb(36,113,163)',.35),
    mt(M.growth_plate,'Growth plate','rgb(192,57,43)',1),
    ...lineTraces,
    {type:'scatter3d',mode:'markers',name:'Landmarks',x:L.map(l=>l.mx),y:L.map(l=>l.my),z:L.map(l=>l.mz),
     marker:{size:6,color:L.map(l=>BM.rgb(l.name)),line:{color:'#fff',width:1.5}},
     text:L.map(l=>'<b>'+l.name.replace(/_/g,' ')+'</b> ('+l.bone+')<br>'+l.mx+', '+l.my+', '+l.mz+' mm'),
     hoverinfo:'text'},
    {type:'scatter3d',mode:'markers',name:'Slice cursor',x:[],y:[],z:[],visible:false,
     marker:{size:9,color:'rgba(93,173,226,.95)',symbol:'x',line:{color:'#fff',width:1}}}];
  BM3D.cursorIdx=traces.length-1;
  function layout(){ const d=document.documentElement.classList.contains('dark');
    const grid=d?'#2a3346':'#d8dee9', txt=d?'#93a1b5':'#5a6a80', bg=d?'#12151c':'#f4f6fa';
    return {paper_bgcolor:bg,font:{color:txt},margin:{l:0,r:0,t:0,b:0},
      showlegend:true, legend:{x:0,y:1,bgcolor:'rgba(0,0,0,0)',font:{size:11},
        itemclick:'toggle',itemdoubleclick:'toggleothers'},
      scene:{aspectmode:'data',xaxis:{title:'ML',color:txt,gridcolor:grid},
        yaxis:{title:'AP',color:txt,gridcolor:grid},
        zaxis:{title:'prox→dist',color:txt,gridcolor:grid,autorange:'reversed'}}};}
  Plotly.newPlot(elt,traces,layout(),{responsive:true,scrollZoom:true,displaylogo:false});
  BM3D.retheme=()=>Plotly.relayout(elt,layout());
  BM3D.elt=elt; BM3D.meta=meta;
  // restore any cursor left by a slice page
  const s=BM.state(); if(s.cursor_mm){ BM3D.setCursor(s.cursor_mm); }
};
BM3D.setCursor=function(mm){ if(!BM3D.elt) return;
  Plotly.restyle(BM3D.elt,{x:[[mm[0]]],y:[[mm[1]]],z:[[mm[2]]],visible:true},[BM3D.cursorIdx]); };

/* ---------- MPR viewer/editor (femur.html, tibia.html) ---------- */
/* mini read-only 3D on a bone page: this bone's mesh + its landmarks +
   measurement lines + a live cursor/edited-point, kept in sync with placement. */
BM.mini3d=null;
BM.buildMini=function(elt,bone,LM,meta){
  const M=window.BM_MESHES; const col=bone==='femur'?'rgb(192,57,43)':'rgb(36,113,163)';
  function d(a,b){return a&&b?Math.sqrt((a.mx-b.mx)**2+(a.my-b.my)**2+(a.mz-b.mz)**2):NaN;}
  const bn={}; LM.forEach(l=>bn[l.name]=l);
  const MEAS=bone==='femur'
    ?[['condyle_lateral','condyle_medial','#e67e22'],['intercondylar_notch','intercondylar_groove','#8e44ad']]
    :[['tibial_condyle_lateral','tibial_condyle_medial','#16a085']];
  function traces(){
    const t=[{type:'mesh3d',x:M[bone].x,y:M[bone].y,z:M[bone].z,i:M[bone].i,j:M[bone].j,k:M[bone].k,
      color:col,opacity:.3,name:bone,hoverinfo:'skip',showlegend:false,lighting:{ambient:.6,diffuse:.7}}];
    MEAS.forEach(m=>{const A=bn[m[0]],B=bn[m[1]];if(A&&B)t.push({type:'scatter3d',mode:'lines',
      x:[A.mx,B.mx],y:[A.my,B.my],z:[A.mz,B.mz],line:{color:m[2],width:6},
      name:(m[0].includes('length')?'L':'W')+' '+d(A,B).toFixed(2),hoverinfo:'name',showlegend:false});});
    t.push({type:'scatter3d',mode:'markers',x:LM.map(l=>l.mx),y:LM.map(l=>l.my),z:LM.map(l=>l.mz),
      marker:{size:5,color:LM.map(l=>BM.rgb(l.name)),line:{color:'#fff',width:1}},
      text:LM.map(l=>l.name.replace(/_/g,' ')),hoverinfo:'text',showlegend:false});
    return t;
  }
  const d0=document.documentElement.classList.contains('dark');
  Plotly.newPlot(elt,traces(),{margin:{l:0,r:0,t:0,b:0},paper_bgcolor:d0?'#12151c':'#f4f6fa',
    scene:{aspectmode:'data',xaxis:{visible:false},yaxis:{visible:false},
      zaxis:{visible:false,autorange:'reversed'}},showlegend:false},
    {responsive:true,displaylogo:false,displayModeBar:false});
  BM.mini3d={elt,traces,bn,LM};
};
BM.miniRefresh=function(){ if(!BM.mini3d)return; const m=BM.mini3d;
  Plotly.react(m.elt,m.traces(),m.elt.layout,{responsive:true,displayModeBar:false}); };

BM.MPR=async function(bone){
  const meta=await BM.loadMeta();
  const D=window['BM_'+bone];   // loaded via <script src="data/<bone>.js">

  const MPR=D.mpr, xf=meta.xf[bone], PLANES=['coronal','sagittal','axial'];
  const PGEO={coronal:{ia:1,row:0,col:2},sagittal:{ia:2,row:0,col:1},axial:{ia:0,row:1,col:2}};
  let showOver=true, showCross=true, showLmk=true, place=false, selName=null;
  const st0=BM.state();
  let LM=(st0.landmarks_edited&&st0.landmarks_edited[bone])?
    JSON.parse(JSON.stringify(st0.landmarks_edited[bone])):
    D.landmarks.map(l=>({...l}));
  const AUTO=D.landmarks.map(l=>({...l}));
  const idx={}, canv={}, ctxs={};
  PLANES.forEach(p=>{canv[p]=document.getElementById('c_'+p);ctxs[p]=canv[p].getContext('2d');
    idx[p]=Math.floor(MPR[p].n/2);});
  const s0=MPR.shape; let cross=[s0[0]/2|0,s0[1]/2|0,s0[2]/2|0];
  const cache={};
  function img(kind,p,i){ const k=kind+p+i; if(cache[k])return cache[k];
    const a=MPR[p][kind]; if(!a||!a[i])return null;
    const im=new Image(); im.src='data:image/'+(kind==='gray'?'jpeg':'png')+';base64,'+a[i];
    im.onload=()=>draw(p); cache[k]=im; return im; }
  function fit(p){ const im=img('gray',p,idx[p]); const cv=canv[p];
    const iw=(im&&im.naturalWidth)||MPR[p].shape[1], ih=(im&&im.naturalHeight)||MPR[p].shape[0];
    const s=Math.min(cv.width/iw,cv.height/ih)*0.97; return {s,ox:(cv.width-iw*s)/2,oy:(cv.height-ih*s)/2,iw,ih}; }
  function lmc(l){ return [(l.az-MPR.crop_origin[0])/MPR.step,(l.ay-MPR.crop_origin[1])/MPR.step,(l.ax-MPR.crop_origin[2])/MPR.step]; }
  function draw(p){ const cv=canv[p],ctx=ctxs[p]; ctx.fillStyle='#0a0d13';ctx.fillRect(0,0,cv.width,cv.height);
    const f=fit(p),g=img('gray',p,idx[p]);
    if(g&&g.complete){ctx.imageSmoothingEnabled=true;ctx.drawImage(g,f.ox,f.oy,f.iw*f.s,f.ih*f.s);
      if(showOver){const o=img('over',p,idx[p]);if(o&&o.complete)ctx.drawImage(o,f.ox,f.oy,f.iw*f.s,f.ih*f.s);}}
    const G=PGEO[p];
    if(showCross){const cx=f.ox+cross[G.col]*f.s,cy=f.oy+cross[G.row]*f.s;
      ctx.strokeStyle='rgba(93,173,226,.85)';ctx.lineWidth=1;
      ctx.beginPath();ctx.moveTo(cx,f.oy);ctx.lineTo(cx,f.oy+f.ih*f.s);ctx.moveTo(f.ox,cy);ctx.lineTo(f.ox+f.iw*f.s,cy);ctx.stroke();}
    if(showLmk) LM.forEach(l=>{ const c=lmc(l),near=Math.abs(c[G.ia]-idx[p])<=1;
      const x=f.ox+c[G.col]*f.s,y=f.oy+c[G.row]*f.s;
      ctx.beginPath();ctx.arc(x,y,near?8:5,0,7);ctx.strokeStyle=BM.rgb(l.name);
      ctx.lineWidth=(l.name===selName)?4:2.5;ctx.globalAlpha=near?1:.35;ctx.stroke();
      // white halo so any marker color is visible on any background
      ctx.beginPath();ctx.arc(x,y,(near?8:5)+2,0,7);ctx.strokeStyle='rgba(255,255,255,.5)';ctx.lineWidth=1;ctx.stroke();
      ctx.globalAlpha=1;
      if(near){ctx.fillStyle=BM.rgb(l.name);ctx.font='10px sans-serif';ctx.fillText(l.name.replace(/_/g,' '),x+10,y+3);}});
    document.getElementById('tag_'+p).textContent=(idx[p]+1)+'/'+MPR[p].n; }
  function drawAll(){PLANES.forEach(draw); if(BM.mini3d) BM.miniRefresh();}
  function tapTo(p,e){ const r=canv[p].getBoundingClientRect(),f=fit(p);
    const px=(e.clientX-r.left-f.ox)/f.s,py=(e.clientY-r.top-f.oy)/f.s;
    if(px<0||py<0||px>f.iw||py>f.ih)return; const G=PGEO[p],cr=cross.slice();
    cr[G.col]=Math.round(px);cr[G.row]=Math.round(py);cross=cr;
    PLANES.forEach(q=>{if(q!==p){idx[q]=cr[PGEO[q].ia];document.getElementById('s_'+q).value=idx[q];}});
    // map cross (cropped-ds vox) -> aligned vox -> raw vox -> mm, store for the 3D page
    const av=[cr[0]*MPR.step+MPR.crop_origin[0],cr[1]*MPR.step+MPR.crop_origin[1],cr[2]*MPR.step+MPR.crop_origin[2]];
    const Rt=xf.Rt,off=xf.off;
    const rv=[Rt[0][0]*av[0]+Rt[0][1]*av[1]+Rt[0][2]*av[2]+off[0],
              Rt[1][0]*av[0]+Rt[1][1]*av[1]+Rt[1][2]*av[2]+off[1],
              Rt[2][0]*av[0]+Rt[2][1]*av[1]+Rt[2][2]*av[2]+off[2]];
    BM.patch({cursor_mm:[+(rv[2]*meta.voxel_mm).toFixed(3),+(rv[1]*meta.voxel_mm).toFixed(3),+(rv[0]*meta.voxel_mm).toFixed(3)]});
    if(place&&selName){ // provisional move — not committed until Save
      pending={name:selName,az:av[0],ay:av[1],ax:av[2],
        mx:+(rv[2]*meta.voxel_mm).toFixed(3),my:+(rv[1]*meta.voxel_mm).toFixed(3),mz:+(rv[0]*meta.voxel_mm).toFixed(3)};
      applyPending(); updateMeas(); buildLmList(); showSaveBar(true); }
    drawAll(); }
  let pending=null;
  function applyPending(){ if(!pending)return; const l=LM.find(x=>x.name===pending.name); if(!l)return;
    l._bak=l._bak||{az:l.az,ay:l.ay,ax:l.ax,mx:l.mx,my:l.my,mz:l.mz,edited:l.edited};
    l.az=pending.az;l.ay=pending.ay;l.ax=pending.ax;l.mx=pending.mx;l.my=pending.my;l.mz=pending.mz;l.edited=true; }
  function showSaveBar(on){ const b=document.getElementById('savebar'); if(b) b.style.display=on?'flex':'none'; }
  function commitPending(){ const l=pending&&LM.find(x=>x.name===pending.name); if(l) delete l._bak;
    pending=null; persistLM(); showSaveBar(false); buildLmList(); }
  function cancelPending(){ if(pending){ const l=LM.find(x=>x.name===pending.name);
    if(l&&l._bak){ Object.assign(l,l._bak); delete l._bak; } }
    pending=null; updateMeas(); buildLmList(); drawAll(); BM.miniRefresh&&BM.miniRefresh(); showSaveBar(false); }
  function persistLM(){ const s=BM.state(); s.landmarks_edited=s.landmarks_edited||{};
    s.landmarks_edited[bone]=LM; BM.save(s); }
  PLANES.forEach(p=>{const cv=canv[p];
    cv.addEventListener('pointerdown',e=>{cv.setPointerCapture(e.pointerId);tapTo(p,e);});
    cv.addEventListener('pointermove',e=>{if(e.buttons)tapTo(p,e);});
    document.getElementById('s_'+p).addEventListener('input',ev=>{idx[p]=+ev.target.value;draw(p);});});
  // measurements
  function get(n){return LM.find(l=>l.name===n)||(bone==='femur'?null:null);}
  function d3(a,b){if(!a||!b)return NaN;return Math.sqrt((a.mx-b.mx)**2+(a.my-b.my)**2+(a.mz-b.mz)**2);}
  function updateMeas(){ const mb=document.getElementById('measbox'); if(!mb)return;
    if(bone==='femur'){ const W=d3(get('condyle_lateral'),get('condyle_medial')),Ln=d3(get('intercondylar_notch'),get('intercondylar_groove'));
      document.getElementById('wlbig').textContent=(W/Ln).toFixed(3);
      document.getElementById('wlhint').textContent='auto W/L '+meta.measurements.wl_ratio+' · normal <1.28 · OA >1.30';
      mb.innerHTML=kv('Femur width',W.toFixed(3)+' mm')+kv('Femur length',Ln.toFixed(3)+' mm')+kv('W/L ratio',(W/Ln).toFixed(3));
    } else { const TW=d3(get('tibial_condyle_lateral'),get('tibial_condyle_medial'));
      const big=document.getElementById('wlbig'); if(big){big.textContent=TW.toFixed(3);document.getElementById('wlhint').textContent='tibia width (mm)';}
      mb.innerHTML=kv('Tibia width',TW.toFixed(3)+' mm')+kv('Med. comp. height',meta.measurements.med_compartment_height_mm+' mm (auto)')+kv('Lat. comp. height',meta.measurements.lat_compartment_height_mm+' mm (auto)');
    } }
  function kv(k,v){return '<div class="kv"><span>'+k+'</span><b>'+v+'</b></div>';}
  function buildLmList(){ const el=document.getElementById('lmlist'); if(!el)return; el.innerHTML='';
    LM.forEach(l=>{ const d=document.createElement('div'); d.className='lm'+(l.name===selName?' sel':'')+(l.edited?' edited':'');
      d.innerHTML='<span class="dot" style="background:'+BM.rgb(l.name)+'"></span><span class="nm">'+l.name.replace(/_/g,' ')+'</span><span class="co">'+l.mx+','+l.my+','+l.mz+'</span>';
      d.onclick=()=>{selName=l.name; const c=lmc(l);
        PLANES.forEach(p=>{idx[p]=Math.round(c[PGEO[p].ia]);document.getElementById('s_'+p).value=idx[p];});
        cross=c.map(Math.round); buildLmList(); drawAll();}; el.appendChild(d);});}
  // wire toggles present on the page
  function tog(id,get,set){const b=document.getElementById(id);if(!b)return;
    b.onclick=()=>{set(!get());b.classList.toggle('on',get());draw&&drawAll();};}
  tog('tglOver',()=>showOver,v=>showOver=v); tog('tglCross',()=>showCross,v=>showCross=v);
  tog('tglLmk',()=>showLmk,v=>showLmk=v);
  const pb=document.getElementById('tglPlace'); if(pb) pb.onclick=()=>{place=!place;pb.classList.toggle('on',place);pb.textContent=(place?'☑':'☐')+' Place mode';};
  const rb=document.getElementById('btnResetLmk'); if(rb) rb.onclick=()=>{LM=AUTO.map(l=>({...l}));selName=null;pending=null;persistLM();updateMeas();buildLmList();drawAll();BM.miniRefresh&&BM.miniRefresh();showSaveBar(false);};
  const sv=document.getElementById('btnSaveLmk'); if(sv) sv.onclick=commitPending;
  const cn=document.getElementById('btnCancelLmk'); if(cn) cn.onclick=cancelPending;
  // live mini-3D on the bone page (read-only view of what placement is doing)
  const mini=document.getElementById('mini3d'); if(mini&&window.Plotly) BM.buildMini(mini,bone,LM,meta);
  function resize(){PLANES.forEach(p=>{const cv=canv[p],r=cv.parentElement.getBoundingClientRect();cv.width=r.width;cv.height=r.height;});}
  window.addEventListener('resize',()=>{resize();drawAll();});
  PLANES.forEach(p=>{const s=document.getElementById('s_'+p);s.max=MPR[p].n-1;s.value=idx[p];});
  resize(); buildLmList(); updateMeas(); drawAll();
  setTimeout(drawAll,300); setTimeout(drawAll,900);
};
