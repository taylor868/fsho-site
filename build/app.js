/* ===== FSHO CONFIG: the only switches ===== */
var FSHO={endpoint:"",/* site.json lead_form.endpoint, and only when lead_form.enabled. Empty = preview, nothing sent */
tracking:false,/* single flag: GTM + ClickCease load after window load */
gtm:"GTM-WWPBQGDZ",clickcease:"" /* ClickCease site ID TBD */};
(function(){var K=["gclid","utm_campaign","utm_term","utm_source","utm_medium"],q=new URLSearchParams(location.search),A={};
try{A=JSON.parse(localStorage.getItem("fsho_attr")||"{}")}catch(e){}
K.forEach(function(k){var v=q.get(k);if(v)A[k]=v});try{localStorage.setItem("fsho_attr",JSON.stringify(A))}catch(e){}
document.querySelectorAll("input[type=hidden]").forEach(function(i){if(A[i.name])i.value=A[i.name]});
function send(d,next,f){d.page=location.pathname;d.ts=new Date().toISOString();
var go=function(){location.href=next};if(!FSHO.endpoint){console.info("FSHO partial lead (preview, not sent):",d);return go()}
function bad(){var n=f.querySelector(".senderr");if(!n){n=document.createElement("p");n.className="senderr";f.appendChild(n)}n.textContent="We couldn't save that. Please call or text us."}
fetch(FSHO.endpoint,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(d)}).then(function(r){return r.json().then(function(b){if(b&&b.ok)return go();if(b&&b.error==="partial_deferred")return go();bad()},bad)},bad)}
function data(f){var o={};new FormData(f).forEach(function(v,k){o[k]=v});return o}
function ok(f){var bad=[].find.call(f.querySelectorAll("fieldset:not([hidden]) [required]"),function(x){return!x.checkValidity()});if(bad){bad.classList.add("err");bad.focus();return false}return true}
document.querySelectorAll("form.lead").forEach(function(f){var a=f.querySelector(".s1"),b=f.querySelector(".s2"),i=f.querySelectorAll(".steps-ind li");
f.querySelector(".nx").onclick=function(){if(!ok(f))return;a.hidden=true;b.hidden=false;i[1].classList.add("on");b.querySelector("input").focus()};
f.querySelector(".bk").onclick=function(){b.hidden=true;a.hidden=false;i[1].classList.remove("on")};
f.onsubmit=function(e){e.preventDefault();if(!ok(f))return;var d=data(f);d.form="qualifier";d.stage="partial";d.lead_id=Date.now().toString(36)+Math.random().toString(36).slice(2,7);d.consent=!!d.consent;try{sessionStorage.setItem("fsho_lead",JSON.stringify({lead_id:d.lead_id,first:d.first,last:d.last,address:d.address,phone:d.phone,email:d.email,consent:d.consent}))}catch(x){}send(d,"/step-2/",f)}});
var s2=document.querySelector("form.step2");if(s2){var L={};try{L=JSON.parse(sessionStorage.getItem("fsho_lead")||"{}")}catch(e){}
["address","phone","email"].forEach(function(k){var x=s2.querySelector("[name="+k+"]");if(x&&L[k])x.value=L[k]});
s2.onsubmit=function(e){e.preventDefault();if(!ok(s2))return;send(data(s2),"/thank-you/",s2)}}
document.addEventListener("click",function(e){var v=e.target.closest(".vid");if(!v)return;var f=document.createElement("iframe");
f.src="https://www.youtube-nocookie.com/embed/"+v.dataset.yt+"?autoplay=1";f.allow="autoplay;encrypted-media;picture-in-picture";f.allowFullscreen=true;f.title="Seller video";f.className="vidf";v.replaceWith(f)});
if(FSHO.tracking)addEventListener("load",function(){setTimeout(function(){
if(FSHO.gtm){window.dataLayer=window.dataLayer||[];dataLayer.push({"gtm.start":Date.now(),event:"gtm.js"});var g=document.createElement("script");g.async=1;g.src="https://www.googletagmanager.com/gtm.js?id="+FSHO.gtm;document.head.appendChild(g)}
if(FSHO.clickcease){var c=document.createElement("script");c.async=1;c.src="https://www.clickcease.com/monitor/stat.js";document.head.appendChild(c)}},1500)})})();
