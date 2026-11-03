(function(){var r=document.getElementById("qf");if(!r)return;
var C=JSON.parse(document.getElementById("qcfg").textContent),Q={},L={},A={},T=[],H=[],ft="";
C.questions.forEach(function(q){Q[q.id]=q});
try{L=JSON.parse(sessionStorage.getItem("fsho_lead")||"{}")}catch(e){}
try{var at=JSON.parse(localStorage.getItem("fsho_attr")||"{}")}catch(e){at={}}
var bar=r.querySelector(".qbar i"),box=r.querySelector(".qbox"),n=C.questions.length;
function el(t,c,x){var e=document.createElement(t);if(c)e.className=c;if(x)e.textContent=x;return e}
function show(id){var q=Q[id];H.push(id);bar.style.width=Math.min(95,Math.round(100*H.length/(n+1)))+"%";box.innerHTML="";
var h=el("h2","",q.label);h.tabIndex=-1;box.appendChild(h);
if(q.type=="text"){var t=el("textarea");t.rows=3;box.appendChild(t);var b=el("button","btn btn-o","Continue");b.type="button";
b.onclick=function(){A[id]=t.value.slice(0,500);go(q.next)};box.appendChild(b)}
else q.options.forEach(function(o){var b=el("button","qo",o.label);b.type="button";b.onclick=function(){A[id]=o.value;
if(o.tag)T.push(o.tag);if(o.force_tier)ft=o.force_tier;q._p=o.points||0;go(o.next)};box.appendChild(b)});
if(H.length>1){var k=el("button","bk","\u2190 Back");k.type="button";k.onclick=back;box.appendChild(k)}h.focus()}
function back(){H.pop();var p=H.pop();delete A[p];T=[];ft="";H.forEach(function(i){var q=Q[i];(q.options||[]).forEach(function(o){if(o.value==A[i]){if(o.tag)T.push(o.tag);if(o.force_tier)ft=o.force_tier}})});show(p)}
function go(nx){if(nx.indexOf("@")<0)return show(nx);var s=0;H.forEach(function(i){s+=Q[i]._p||0});
var e,tier,cad;if(nx=="@score"){var t=C.tiers.filter(function(x){return ft?x.id==ft:s>=x.min})[0];tier=t.id;cad=t.cadence;e=C.endings[t.ending]}
else{e=C.endings[nx.slice(5)];tier=e.tier;cad=e.cadence}
var d={form:C.id,form_version:C.version,stage:"complete",lead_id:L.lead_id||"",first:L.first||"",last:L.last||"",phone:L.phone||"",email:L.email||"",address:L.address||"",
answers:A,tags:T,score:s,tier:tier,cadence:cad,conversion:e.conversion,page:location.pathname,ts:new Date().toISOString()};
["gclid","utm_campaign","utm_term","utm_source","utm_medium"].forEach(function(k){d[k]=at[k]||""});
if(C.consent.enabled){d[C.consent.field]=!!L.consent;d.consent_text=C.consent.text}
bar.style.width="100%";box.innerHTML="";box.appendChild(el("h2","",e.headline));box.appendChild(el("p","lede",e.body));
r.dataset.tier=tier;e.conversion!="none"&&window.dataLayer&&dataLayer.push({event:"fsho_qualifier",tier:tier,conversion:e.conversion});
var u=window.FSHO&&FSHO.endpoint;if(!u){console.info("FSHO qualifier lead (preview, not sent):",d);return}
fetch(u,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(d),keepalive:true})}
show(C.start)})();
