(function(){var r=document.getElementById("qf");if(!r)return;
var C=JSON.parse(document.getElementById("qcfg").textContent),Q={},L={},A={},H=[],K="EMOTA".split("");
C.questions.forEach(function(q){Q[q.id]=q});
try{L=JSON.parse(sessionStorage.getItem("fsho_lead")||"{}")}catch(e){}
try{var at=JSON.parse(localStorage.getItem("fsho_attr")||"{}")}catch(e){at={}}
var bar=r.querySelector(".qbar i"),box=r.querySelector(".qbox"),n=C.questions.length;
function el(t,c,x){var e=document.createElement(t);if(c)e.className=c;if(x)e.textContent=x;return e}
function opt(i){var q=Q[i];return(q.options||[]).filter(function(o){return o.value==A[i]})[0]}
function show(id){var q=Q[id];H.push(id);bar.style.width=Math.min(95,Math.round(100*H.length/(n+1)))+"%";box.innerHTML="";
var h=el("h2","",q.label);h.tabIndex=-1;box.appendChild(h);
q.options.forEach(function(o){var b=el("button","qo",o.label);b.type="button";b.onclick=function(){A[id]=o.value;go(o.next)};box.appendChild(b)});
if(H.length>1){var k=el("button","bk","\u2190 Back");k.type="button";k.onclick=function(){H.pop();var p=H.pop();delete A[p];show(p)};box.appendChild(k)}h.focus()}
function go(nx){if(nx.indexOf("@")<0)return show(nx);
var T=[],P={},F=[],e,res;H.forEach(function(i){var o=opt(i),c=Q[i].category,p=o.pass;if(o.tag)T.push(o.tag);
if(p===undefined)return;if(typeof p!="object"){var x={};x[c]=p;p=x}for(var l in p)P[l]=(P[l]!==false)&&p[l]});
if(nx=="@score"){K.forEach(function(l){if(P[l]!==true){P[l]=false;F.push(l)}});
var O={};K.forEach(function(l){O[l]=P[l]});P=O;res=F.length?C.result.any_fail:C.result.all_pass;F.forEach(function(l){T.push(res.fail_tag+l)});if(F.length==1&&res.near_miss_tag)T.push(res.near_miss_tag);e=C.endings[res.ending]}
else{e=C.endings[nx.slice(5)];res=e;P=null;F=null}
var d={form:C.id,form_version:C.version,stage:"complete",lead_id:L.lead_id||"",first:L.first||"",last:L.last||"",phone:L.phone||"",email:L.email||"",address:L.address||"",
answers:A,emota:P,failed:F,tags:T,tier:res.tier,cadence:res.cadence,conversion:e.conversion,page:location.pathname,ts:new Date().toISOString()};
["gclid","utm_campaign","utm_term","utm_source","utm_medium"].forEach(function(k){d[k]=at[k]||""});
if(C.consent.enabled){d[C.consent.field]=!!L.consent;d.consent_text=C.consent.text}
if(L.continuation)d.continuation=L.continuation;
function paint(h,p){bar.style.width="100%";box.innerHTML="";box.appendChild(el("h2","",h));if(p)box.appendChild(el("p","lede",p))}
function saved(){paint(e.headline,e.body);r.dataset.tier=d.tier;e.conversion!="none"&&window.dataLayer&&dataLayer.push({event:"fsho_qualifier",tier:d.tier,conversion:e.conversion})}
function failed(){paint("We couldn't save your answers.","Please call or text us and we'll finish this with you.")}
var hp=r.querySelector("[name=company_website]");if(hp&&hp.value.trim())d.company_website=hp.value;
var u=window.FSHO&&FSHO.endpoint;if(!u){console.info("FSHO qualifier lead (preview, not sent):",d);return saved()}
if(!d.continuation)return failed();
fetch(u,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(d)}).then(function(res){return res.json().then(function(b){b&&b.ok?saved():failed()},failed)},failed)}
show(C.start)})();
