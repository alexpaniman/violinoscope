// Shared flame-graph window math and an independently navigable merged-tree canvas.
(function () {
  'use strict';
  const X = window.TX;
  X.flameWindow = {
    zoom(d0, d1, fraction, factor, extent) {
      const span = d1 - d0, at = d0 + fraction * span, size = X.clamp(span * factor, 1e-6, extent * 1.2);
      return [at - fraction * size, at + (1 - fraction) * size];
    },
    pan(d0, d1, fraction) { const d = fraction * (d1 - d0); return [d0 + d, d1 + d]; },
  };
  X.flameView = (host, tree, bars, options = {}) => {
    const state = options.state || {win:[0,1], history:[]}, inverted = options.inverted, rowH = 18;
    const T = X.T, color = (n) => n.part >= 0 ? T.cols[n.part] : T.unowned;
    host.innerHTML = `<div class="sw-tools"><span>${X.esc(options.label || (inverted ? 'Called from' : 'Calls'))}</span><button type="button" class="text-btn small" data-graph-back>Back</button><button type="button" class="text-btn small" data-graph-all>All</button></div>`
      + '<canvas class="sw-overview" tabindex="0" aria-label="Flame graph overview; drag to choose a range"></canvas>'
      + `<div class="sw-scroll"><canvas class="sw-canvas" tabindex="0" role="img" aria-label="${inverted ? 'Callers' : 'Callees'}: click to zoom, drag to pan, Ctrl+wheel to zoom, Escape to go back"></canvas></div>`;
    if (!inverted) host.append(host.querySelector('.sw-tools'), host.querySelector('.sw-overview'));
    const canvas = host.querySelector('.sw-canvas'), mini = host.querySelector('.sw-overview'), scroll = host.querySelector('.sw-scroll');
    if (bars.depth === 0) { host.querySelector('.sw-tools').hidden = true; mini.hidden = true; }
    const ctx = canvas.getContext('2d'), overview = mini.getContext('2d');
    let hot = [], hover = null, width = 1, drag = null, miniDrag = null, initial = true;
    const remember = () => { const w = state.win; if (!state.history.length || state.history.at(-1).some((v,k)=>v!==w[k])) state.history.push([...w]); if(state.history.length>100)state.history.shift(); };
    const set = (a, b, push = true) => {
      const size = X.clamp(b-a, 1e-6, 1), left = X.clamp(a,0,1-size);
      if (push) remember(); state.win = [left,left+size]; draw();
    };
    const back = () => { if (!state.history.length) return false; state.win = state.history.pop(); draw(); return true; };
    const all = () => set(0,1);
    const active = () => { if(options.activate)options.activate(api); };
    function draw() {
      width = Math.max(1,host.clientWidth);
      const height = Math.max(rowH,(bars.depth+1-(inverted ? 1 : 0))*rowH), [a,b] = state.win;
      canvas.dataset.window = JSON.stringify(state.win);
      ctx.setTransform(...X.toView(X.fitCanvas(canvas,width,height)));
      ctx.clearRect(0,0,width,height); ctx.font=`500 11px ${X.SANS}`;ctx.textBaseline='middle'; hot=[];
      for(const bar of bars.list) {
        if(inverted && bar.d===0) continue;
        const x0=(bar.x0-a)/(b-a)*width, x1=(bar.x1-a)/(b-a)*width;
        if(x1<0||x0>width||x1-x0<0.3)continue;
        const left=Math.max(0,x0),right=Math.min(width,x1),y=(inverted ? bars.depth-bar.d : bar.d)*rowH, c=color(bar.n);
        const fill=bar.n.async ? X.mix(c,T.bg,.8) : c;
        ctx.fillStyle=fill;ctx.fillRect(left,y,Math.max(0.5,right-left-1),rowH-1);
        if(bar.n.async){ctx.strokeStyle=c;ctx.lineWidth=1;ctx.strokeRect(left+.5,y+.5,Math.max(0,right-left-2),rowH-2);}
        if(bar.n===tree||bar===hover){ctx.strokeStyle=T.ink;ctx.lineWidth=1;ctx.strokeRect(left+.5,y+.5,Math.max(0,right-left-2),rowH-2);}
        if(right-left>26){const text=X.fitText(bar.n.name,11,500,right-left-8);if(text){ctx.fillStyle=X.inkOn(fill);ctx.fillText(text,left+4,y+rowH/2);}}
        hot.push({bar,x0:left,x1:right,y0:y,y1:y+rowH});
      }
      const mh=40;
      overview.setTransform(...X.toView(X.fitCanvas(mini,width,mh)));overview.clearRect(0,0,width,mh);
      for(const bar of bars.list) {overview.fillStyle=color(bar.n); const y=bar.d/Math.max(1,bars.depth+1)*mh;overview.fillRect(bar.x0*width,y,Math.max(.5,(bar.x1-bar.x0)*width),Math.max(1,mh/(bars.depth+1)-.5));}
      overview.fillStyle=T.bg;overview.globalAlpha=.65;overview.fillRect(0,0,a*width,mh);overview.fillRect(b*width,0,(1-b)*width,mh);overview.globalAlpha=1;
      overview.strokeStyle=T.ink;overview.lineWidth=1.5;overview.strokeRect(a*width+.75,.75,Math.max(0,(b-a)*width-1.5),mh-1.5);
      host.querySelector('[data-graph-back]').disabled=!state.history.length;
      host.querySelector('[data-graph-all]').disabled=a===0&&b===1;
      if(initial&&inverted){scroll.scrollTop=height;initial=false;}
    }
    const point=(e,c=canvas)=>{const r=c.getBoundingClientRect();return [e.clientX-r.left,e.clientY-r.top];};
    const at=(e)=>{const [x,y]=point(e);return hot.find(h=>x>=h.x0&&x<h.x1&&y>=h.y0&&y<h.y1)?.bar;};
    canvas.onpointerdown=(e)=>{if(e.button!==0)return;active();canvas.focus({preventScroll:true});drag={x:e.clientX,win:[...state.win],moved:false};canvas.setPointerCapture(e.pointerId);};
    canvas.onpointermove=(e)=>{
      if(drag){const dx=e.clientX-drag.x;if(!drag.moved&&Math.abs(dx)>3){remember();drag.moved=true;}if(drag.moved){set(...X.flameWindow.pan(...drag.win,-dx/width),false);X.hideTip();}return;}
      const bar=at(e)||null;if(bar!==hover){hover=bar;draw();}canvas.style.cursor=bar?'pointer':'';
      if(!bar){X.hideTip();return;}const r=X.$('stage').getBoundingClientRect();
      const lines=[bar.n.name,`${X.fmtMs(bar.n.dur)} · ${X.fmtPct(bar.n.dur/tree.dur)} of ${tree.name}`,`${X.fmtInt(bar.n.n)} spans`];
      if(bar.n.async)lines.push(bar.n.mixed?'Includes occurrences in separate logical flows':'Within a separate logical flow');
      lines.push('Click to zoom · double-click to select');X.tip(lines,e.clientX-r.left,e.clientY-r.top);
    };
    canvas.onpointerup=(e)=>{if(!drag)return;const moved=drag.moved;drag=null;if(!moved){const bar=at(e);if(bar)set(bar.x0,bar.x1);}canvas.releasePointerCapture(e.pointerId);};
    canvas.onpointercancel=()=>{drag=null;};
    canvas.onpointerleave=()=>{hover=null;X.hideTip();draw();};
    canvas.ondblclick=(e)=>{const bar=at(e);if(bar&&options.pick)options.pick(bar.n.name);};
    canvas.addEventListener('wheel',(e)=>{
      active();if(e.ctrlKey||e.metaKey){e.preventDefault();set(...X.flameWindow.zoom(...state.win,point(e)[0]/width,Math.exp(e.deltaY*.004),1));}
      else if(e.shiftKey||Math.abs(e.deltaX)>Math.abs(e.deltaY)){e.preventDefault();set(...X.flameWindow.pan(...state.win,(e.shiftKey?e.deltaY:e.deltaX)/width));}
    },{passive:false});
    mini.onpointerdown=(e)=>{if(e.button!==0)return;active();remember();miniDrag=point(e,mini)[0]/width;mini.setPointerCapture(e.pointerId);};
    mini.onpointermove=(e)=>{if(miniDrag===null)return;const x=point(e,mini)[0]/width;if(Math.abs(x-miniDrag)>.003)set(Math.min(x,miniDrag),Math.max(x,miniDrag),false);};
    mini.onpointerup=(e)=>{if(miniDrag===null)return;const x=point(e,mini)[0]/width;if(Math.abs(x-miniDrag)<.003){const size=state.win[1]-state.win[0];set(x-size/2,x+size/2,false);}miniDrag=null;mini.releasePointerCapture(e.pointerId);};
    mini.onpointercancel=()=>{miniDrag=null;};
    mini.ondblclick=all;
    host.querySelector('[data-graph-back]').onclick=()=>{active();back();};
    host.querySelector('[data-graph-all]').onclick=()=>{active();all();};
    host.onkeydown=(e)=>{
      let handled=true;const k=e.key.toLowerCase();active();
      if(k==='escape')handled=back();else if(k==='f')all();
      else if(k==='w'||k==='s')set(...X.flameWindow.zoom(...state.win,.5,k==='w'?.8:1.25,1));
      else if(k==='a'||k==='d')set(...X.flameWindow.pan(...state.win,k==='a'?-.15:.15));else handled=false;
      if(handled){e.preventDefault();e.stopPropagation();}
    };
    const observer=new ResizeObserver(draw);observer.observe(host);
    const api={back,state,dispose:()=>observer.disconnect()};draw();return api;
  };
})();
