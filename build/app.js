/* ===== FSHO CONFIG: the only switches ===== */
var FSHO={endpoint:"",/* e.g. Zapier/Make webhook -> Carrot CRM + Twilio SMS. Empty = local demo, nothing sent */
tracking:false,/* single flag: GTM + ClickCease load after window load */
gtm:"GTM-WWPBQGDZ",clickcease:"" /* ClickCease site ID TBD */};
(function(){var K=["gclid","gbraid","wbraid","utm_source","utm_medium","utm_campaign","utm_term","utm_content"],I={"gclid":1,"gbraid":1,"wbraid":1},q=new URLSearchParams(location.search),A={},n=Date.now(),id=0;
try{A=JSON.parse(localStorage.getItem("fsho_attr")||"{}")}catch(e){}
if(A.t&&n-A.t>7776e6)A={};
K.forEach(function(k){if(q.get(k)&&I[k])id=1});
if(id){A={t:n};K.forEach(function(k){var v=q.get(k);if(v)A[k]=v})}
else{K.forEach(function(k){var v=q.get(k);if(v){A[k]=v;A.t=n}});if(!A.t){var keep=0;K.forEach(function(k){if(A[k])keep=1});if(keep)A.t=n}}
try{if(A.t)localStorage.setItem("fsho_attr",JSON.stringify(A));else localStorage.removeItem("fsho_attr")}catch(e){}
document.querySelectorAll("input[type=hidden]").forEach(function(i){if(A[i.name])i.value=A[i.name]});
function tag(a){try{var u=new URL(a.href);if(u.hostname.replace(/^www\./,"")!=="fairandsimplehomeoffer.com")return;var c=0;K.forEach(function(k){if(A[k]&&!u.searchParams.has(k)){u.searchParams.set(k,A[k]);c=1}});if(c)a.href=u.href}catch(e){}}
document.querySelectorAll('a[href*="fairandsimplehomeoffer.com"]').forEach(tag);
function send(d,next){d.page=location.pathname;d.ts=new Date().toISOString();
var go=function(){location.href=next};if(!FSHO.endpoint){console.info("FSHO partial lead (preview, not sent):",d);return go()}
fetch(FSHO.endpoint,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(d),keepalive:true}).then(go,go)}
function data(f){var o={};new FormData(f).forEach(function(v,k){o[k]=v});return o}
function ok(f){var bad=[].find.call(f.querySelectorAll("fieldset:not([hidden]) [required]"),function(x){return!x.checkValidity()});if(bad){bad.classList.add("err");bad.focus();return false}return true}
document.querySelectorAll("form.lead").forEach(function(f){var a=f.querySelector(".s1"),b=f.querySelector(".s2"),i=f.querySelectorAll(".steps-ind li");
f.querySelector(".nx").onclick=function(){if(!ok(f))return;a.hidden=true;b.hidden=false;i[1].classList.add("on");b.querySelector("input").focus()};
f.querySelector(".bk").onclick=function(){b.hidden=true;a.hidden=false;i[1].classList.remove("on")};
f.onsubmit=function(e){e.preventDefault();if(!ok(f))return;var d=data(f);d.form="qualifier";d.stage="partial";d.lead_id=Date.now().toString(36)+Math.random().toString(36).slice(2,7);d.consent=!!d.consent;try{sessionStorage.setItem("fsho_lead",JSON.stringify({lead_id:d.lead_id,first:d.first,last:d.last,address:d.address,phone:d.phone,email:d.email,consent:d.consent}))}catch(x){}send(d,"/step-2/")}});
var s2=document.querySelector("form.step2");if(s2){var L={};try{L=JSON.parse(sessionStorage.getItem("fsho_lead")||"{}")}catch(e){}
["address","phone","email"].forEach(function(k){var x=s2.querySelector("[name="+k+"]");if(x&&L[k])x.value=L[k]});
s2.onsubmit=function(e){e.preventDefault();if(!ok(s2))return;send(data(s2),"/thank-you/")}}
document.addEventListener("click",function(e){var v=e.target.closest(".vid");if(!v)return;var f=document.createElement("iframe");
f.src="https://www.youtube-nocookie.com/embed/"+v.dataset.yt+"?autoplay=1";f.allow="autoplay;encrypted-media;picture-in-picture";f.allowFullscreen=true;f.title="Seller video";f.className="vidf";v.replaceWith(f)});
if(FSHO.tracking)addEventListener("load",function(){setTimeout(function(){
if(FSHO.gtm){window.dataLayer=window.dataLayer||[];dataLayer.push({"gtm.start":Date.now(),event:"gtm.js"});var g=document.createElement("script");g.async=1;g.src="https://www.googletagmanager.com/gtm.js?id="+FSHO.gtm;document.head.appendChild(g)}
if(FSHO.clickcease){var c=document.createElement("script");c.async=1;c.src="https://www.clickcease.com/monitor/stat.js";document.head.appendChild(c)}},1500)})})();
