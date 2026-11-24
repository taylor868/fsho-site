/* MOCKUP ONLY (/mockups/seller/). Sends nothing: no fetch/XHR/beacon POSTs, no tracking, no CRM. */
(function(){
"use strict";
var d=document,w=window,q=new URLSearchParams(location.search);
var C=JSON.parse(d.getElementById("mk-data").textContent);
/* 1. Hard stop on any outgoing send, in case something else ever loads on this page. */
var of=w.fetch;if(of)w.fetch=function(u,o){if(o&&o.method&&String(o.method).toUpperCase()!=="GET"){console.info("[mockup] blocked send to",u);return Promise.resolve(new Response("{}",{status:204}))}return of.apply(this,arguments)};
if(navigator.sendBeacon)navigator.sendBeacon=function(){console.info("[mockup] blocked beacon");return true};
var xo=XMLHttpRequest.prototype.open,xs=XMLHttpRequest.prototype.send;
XMLHttpRequest.prototype.open=function(m){this._mk=String(m).toUpperCase()!=="GET";return xo.apply(this,arguments)};
XMLHttpRequest.prototype.send=function(){if(this._mk){console.info("[mockup] blocked XHR send");return}return xs.apply(this,arguments)};
w.FSHO_MOCKUP=true;

/* Which ideas are on. Default: all 7. */
var ip=(q.get("ideas")||"1,2,3,4,5,6,7").toLowerCase(),on={};
if(ip!=="none")ip.split(/[ ,]+/).forEach(function(n){on[n]=true});
d.querySelectorAll("[data-idea]").forEach(function(el){if(on[el.getAttribute("data-idea")]&&el.id!=="mk-resume")el.hidden=false});
var oldbar=d.getElementById("mk-oldbar");if(on["5"]&&oldbar)oldbar.hidden=true;
function $(id){return d.getElementById(id)}
function txt(id,s){var el=$(id);if(el)el.textContent=s}
var info=[];function note(k,v){info.push([k,v])}

/* Idea 1: bucket from kw / keyword / utm_term / utm_campaign (or sit=). */
var src=["kw","keyword","utm_term","utm_campaign","campaign"].map(function(k){return q.get(k)||""}).join(" ").toLowerCase().replace(/[+_]/g," ");
function bucketById(id){for(var i=0;i<C.buckets.length;i++)if(C.buckets[i].id===id)return C.buckets[i];return null}
function pick(){var s=(q.get("sit")||"").toLowerCase(),b=bucketById(s);if(b)return{b:b,why:"sit="+s};
for(var i=0;i<C.buckets.length;i++){var x=C.buckets[i];if(x.match&&new RegExp(x.match,"i").test(src))return{b:x,why:'matched "'+src.trim()+'"'}}
return{b:bucketById("generic"),why:src.trim()?'no match for "'+src.trim()+'", safe default':"no keyword, safe default"}}
var P=pick(),bucket=P.b;
/* Idea 3: city from ?city= (letters, spaces, . ' - only) or later from the typed address. */
function cleanCity(s){s=(s||"").replace(/\+/g," ").trim();if(!/^[A-Za-z][A-Za-z .'\-]{1,39}$/.test(s))return"";return s.replace(/\b[a-z]/g,function(c){return c.toUpperCase()})}
var city=cleanCity(q.get("city")),citySrc=city?"URL ?city=":"";
function paint(){
 var b=on["1"]?bucket:bucketById("generic");
 txt("mk-h1",b.h1);txt("mk-sub",b.sub);
 txt("mk-eyebrow",on["3"]&&city?"Buying houses in "+city+" as-is \u00b7 No fees \u00b7 No repairs":C.eyebrow);
 if(on["3"]){var ll=$("mk-local-line");ll.hidden=!city;ll.textContent=city?"Ask about your "+city+" house today. No cost, no obligation.":"";
  txt("mk-local-h",city?"Selling a house in "+city+"?":"Selling a house in your area?");
  txt("mk-local-ph","[PLACEHOLDER: real local proof"+(city?" for "+city:"")+" from Andrew, for example homes bought nearby, a closing photo, or a local review. Leave the block out if there is none.]")}
}
/* Idea 2: story + FAQ for the situation, chips to switch. */
var sit=C.stories[bucket.id]?bucket.id:"";
function esc(s){var t=d.createElement("div");t.textContent=s;return t.innerHTML}
function story(){if(!on["2"])return;var box=$("mk-story"),st=C.stories[sit];
 d.querySelectorAll(".mk-chip").forEach(function(c){c.setAttribute("aria-pressed",c.getAttribute("data-sit")===sit?"true":"false")});
 if(!st){box.innerHTML='<p class="mk-empty">Pick the one that fits and this section changes to match it.</p>';return}
 box.className="mk-story";
 box.innerHTML="<h3>"+esc(st.title)+"</h3><p>"+esc(st.lead)+'</p><div class="grid3">'+st.cards.map(function(c){return'<div class="card"><h3>'+esc(c[0])+"</h3><p>"+esc(c[1])+"</p></div>"}).join("")+
 '</div><div class="faq">'+st.faq.map(function(f){return"<details><summary>"+esc(f[0])+"</summary><p>"+esc(f[1])+"</p></details>"}).join("")+
 '</div><p class="more"><a href="'+st.link[0]+'">'+esc(st.link[1])+" &rarr;</a></p>"}
d.querySelectorAll(".mk-chip").forEach(function(c){c.addEventListener("click",function(){sit=c.getAttribute("data-sit");if(on["1"]){bucket=bucketById(sit);paint()}story();info[0]=["Headline bucket",bucket.label+" (picked by chip)"];showInfo()})});

/* Idea 5: after hours by ET clock. ?ah=1 / ?ah=0 forces it. Hours are a PLACEHOLDER (8 AM to 8 PM ET). */
function etHour(){try{var p=new Intl.DateTimeFormat("en-US",{timeZone:C.hours.tz,hour:"numeric",hour12:false}).formatToParts(new Date());for(var i=0;i<p.length;i++)if(p[i].type==="hour")return(+p[i].value)%24}catch(e){}return new Date().getHours()}
var ahq=q.get("ah"),h=etHour(),after=ahq==="1"?true:ahq==="0"?false:(h<C.hours.open||h>=C.hours.close);
if(on["5"]&&after){d.querySelectorAll(".mk-ah").forEach(function(el){el.hidden=false});d.querySelectorAll(".mk-ah-t").forEach(function(el){el.textContent="It's after hours. We'll text you by 9 AM."})}

/* Idea 6: resume, this browser only. Separate key from anything the live site uses. */
var RK="fsho_mockup_resume",rq=q.get("resume");
function rget(){try{return JSON.parse(localStorage.getItem(RK)||"null")}catch(e){return null}}
function rset(v){try{v?localStorage.setItem(RK,JSON.stringify(v)):localStorage.removeItem(RK)}catch(e){}}
if(rq==="clear")rset(null);
if(rq==="demo")rset({a:"123 Sample St"+(city?", "+city:"")+" [sample address]",t:Date.now()});
var form=$("ts-form"),s1=$("ts-s1"),s2=$("ts-s2"),prog=$("ts-prog"),addr=form.querySelector("[name=address]");
function step(n){s1.hidden=n!==1;s1.disabled=n!==1;s2.hidden=n!==2;s2.disabled=n!==2;prog.textContent=n===1?"Step 1 of 3 \u00b7 Property":"Step 2 of 3 \u00b7 Contact";
 if(n===2){txt("ts-addr-echo",addr.value);var f=s2.querySelector("[name=name]");if(f)f.focus()}}
var R=rget();
if(on["6"]&&R&&R.a&&Date.now()-R.t<30*864e5){var rb=$("mk-resume");rb.hidden=false;txt("mk-resume-addr",R.a);
 $("mk-resume-go").addEventListener("click",function(){addr.value=R.a;rb.hidden=true;step(2)});
 $("mk-resume-clear").addEventListener("click",function(){rset(null);rb.hidden=true;addr.value="";addr.focus()})}

/* The stub form. Step 1 -> step 2 -> "Mockup only: nothing was sent." Never posts. */
$("ts-back").addEventListener("click",function(){step(1);addr.focus()});
function bad(fs){var x=[].find.call(fs.querySelectorAll("[required]"),function(i){return!i.checkValidity()});if(x){x.classList.add("err");if(x.name==="consent"){x.setAttribute("aria-invalid","true");txt("consent-err","Please check the box to continue.")}x.focus();return true}return false}
form.addEventListener("submit",function(e){e.preventDefault();e.stopImmediatePropagation();
 if(!s1.hidden){if(bad(s1))return;
  var parts=addr.value.split(",");if(on["3"]&&!city&&parts.length>=2){var c=cleanCity(parts[1]);if(c){city=c;citySrc="typed address";paint();infoCity()}}
  if(on["6"])rset({a:addr.value.trim(),t:Date.now()});step(2);return}
 if(bad(s2))return;rset(null);form.hidden=true;$("mk-done").hidden=false;$("mk-done").querySelector("h2").focus&&$("mk-done").setAttribute("tabindex","-1");$("mk-done").focus();
 console.info("[mockup] form finished, nothing was sent")},true);
$("mk-again").addEventListener("click",function(){form.reset();step(1);form.hidden=false;$("mk-done").hidden=true;txt("consent-err","");addr.focus()});
form.addEventListener("input",function(e){e.target.classList.remove("err");if(e.target.name==="consent"){e.target.removeAttribute("aria-invalid");txt("consent-err","")}});

/* Info panel */
function showInfo(){var dl=$("mk-info");dl.innerHTML=info.map(function(r){return"<dt>"+esc(r[0])+"</dt><dd>"+esc(r[1])+"</dd>"}).join("")}
function infoCity(){info[1]=["City",on["3"]?(city?city+" (from "+citySrc+")":"none (add ?city= or type an address)"):"idea 3 off"];showInfo()}
note("Headline bucket",on["1"]?bucket.label+" ("+P.why+")":"idea 1 off, default headline");
note("City","");
note("After hours",on["5"]?(after?"yes":"no")+(ahq==="1"||ahq==="0"?" (forced by ?ah="+ahq+")":" (ET hour "+h+", placeholder hours 8 AM to 8 PM)"):"idea 5 off");
note("Returning visitor",on["6"]?(R&&R.a?"yes, saved address shown":"no saved address"):"idea 6 off");
note("Ideas on",ip==="none"?"none (baseline)":Object.keys(on).sort().join(", "));
note("Sends",'off. The form, fetch, XHR and beacons are stubbed. No tracking loads.');
paint();story();infoCity();
})();
