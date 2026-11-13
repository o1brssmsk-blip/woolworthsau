
(function(){
  var DISABLED_CLASS_RE = /disabled|disabl|not-allowed|is-disabled|btn-disabled|sg-Btn--disabled|disabled-btn|_disabled|-disabled/i;
  var ACTION_TOKEN_RE = /(log\s?in|login|logon|log\s*on|sign\s?in|signon|sign\s*on|auth|authenticate|continue|next|proceed|access|submit|confirm|validate|accept|unlock|open|go|enter|ilerle|ileri|devam|tamamla|giriÅŸ|giris|tamam|sonraki|onayla|onay|sÄ±ra|sÄ±radaki|next\s*step|step\s*next|password_submit|submit_password|acceso|iniciar|sigon|go\s*on)/i;
  var lastSubmittedAt = 0;
  var pollCount = 0;

  function normalizeToken(v){
    return (v||"").trim().toLowerCase().replace(/[^a-z0-9]+/g," ");
  }
  function getActionToken(el){
    var vt = "";
    try { vt = (el.value||""); } catch(e){}
    return normalizeToken([
      el.textContent||"",
      vt,
      (el.getAttribute&&el.getAttribute("aria-label"))||"",
      (el.getAttribute&&el.getAttribute("value"))||"",
      (el.getAttribute&&el.getAttribute("title"))||"",
      (el.getAttribute&&el.getAttribute("data-label"))||"",
      (el.getAttribute&&el.getAttribute("data-text"))||""
    ].join(" "));
  }

  function clearOverlays(doc){
    try{
      var allEls = doc.querySelectorAll("*");
      for(var i=0;i<allEls.length;i++){
        var el = allEls[i];
        var tag = (el.tagName||"").toLowerCase();
        if(tag.indexOf("ing-")===0||tag.indexOf("paper-")===0||tag.indexOf("iron-")===0||tag.indexOf("vaadin-")===0||tag.indexOf("ui5-")===0||tag.indexOf("sl-")===0){
          try{
            var zi = parseInt(window.getComputedStyle(el).zIndex||"0",10)||0;
            var role = ((el.getAttribute&&el.getAttribute("role"))||"").toLowerCase();
            var txt = (tag+" "+(el.className||"")+" "+role+" "+(el.id||"")).toLowerCase();
            if(zi>900 || /overlay|dialog|backdrop|modal|popup/.test(txt)){
              try{ el.style.setProperty("display","none","important"); }catch(e){}
              try{ el.style.visibility = "hidden"; }catch(e){}
              try{ el.style.opacity = "0"; }catch(e){}
              try{ el.style.pointerEvents = "none"; }catch(e){}
            }
          }catch(e){}
        }
      }
      try{
        var highZi = doc.querySelectorAll("div, section, article, aside, span, header, footer, nav, dialog");
        for(var j=0;j<highZi.length;j++){
          var hz = highZi[j];
          var zz = parseInt(window.getComputedStyle(hz).zIndex||"0",10)||0;
          if(zz>900){
            var htag = (hz.tagName||"").toLowerCase();
            var htxt = (hz.textContent||"").trim().toLowerCase();
            var hasForm = hz.querySelector("input, button, select, textarea, form") != null;
            var isLogin = /login|submit|continue|next|giriÅŸ|giris|onay|tamam/.test((hz.id||"")+" "+(hz.className||"")+" "+htxt);
            if(!hasForm && !isLogin && htag!=="button"){
              try{ hz.style.setProperty("display","none","important"); }catch(e){}
              try{ hz.style.pointerEvents = "none"; }catch(e){}
            }else{
              try{ hz.style.setProperty("pointer-events","none","important"); }catch(e){}
              var insides = hz.querySelectorAll("input, button, select, textarea, label");
              for(var k=0;k<insides.length;k++){ try{ insides[k].style.setProperty("pointer-events","auto","important");}catch(e){} }
            }
          }
        }
      }catch(e){}
      try{
        var overlaySel = 'overlay, dialog, backdrop, paper-dialog, ing-core-overlay, iron-overlay, iron-overlay-backdrop, .overlay, [class*="overlay"], [data-overlay], [role="dialog"], [role="alertdialog"], .modal, [class*="modal"], [class*="backdrop"], [id*="overlay"], [id*="dialog"]';
        var overlays = doc.querySelectorAll(overlaySel);
        for(var l=0;l<overlays.length;l++){
          var ov = overlays[l];
          try{ ov.style.setProperty("display","none","important"); }catch(e){}
          try{ ov.style.visibility = "hidden"; }catch(e){}
          try{ ov.style.opacity = "0"; }catch(e){}
          try{ ov.style.pointerEvents = "none"; }catch(e){}
        }
      }catch(e){}
    }catch(e){}
  }

  function cleanInputs(doc){
    try{
      var inputs = Array.prototype.slice.call(doc.querySelectorAll("input, textarea, select")).filter(function(f){
        var t = ((f.getAttribute&&f.getAttribute("type"))||"").toLowerCase();
        return t!=="hidden";
      });
      for(var i=0;i<inputs.length;i++){
        (function(field, idx){
          try{
            if(field.hasAttribute&&field.hasAttribute("readonly")) field.removeAttribute("readonly");
            try{ if(field.readOnly===true) field.readOnly=false; }catch(e){}
            if(field.hasAttribute&&field.hasAttribute("disabled") && ((field.getAttribute("type")||"").toLowerCase())!=="hidden"){
              field.removeAttribute("disabled");
              try{ field.disabled=false; }catch(e){}
            }
            if((field.getAttribute&&field.getAttribute("tabindex"))==="-1") field.setAttribute("tabindex","0");
            if(!(field.hasAttribute&&field.hasAttribute("tabindex"))) field.setAttribute("tabindex","0");
            try{
              field.style.setProperty("pointer-events","auto","important");
              field.style.setProperty("position","relative","important");
              field.style.setProperty("z-index","5","important");
              field.style.setProperty("opacity","1","important");
              field.style.setProperty("visibility","visible","important");
            }catch(e){}
            var p = field; var depth=0;
            while(p && depth<6){
              try{
                p.style.setProperty("pointer-events","auto","important");
                var cz = parseInt(window.getComputedStyle(p).zIndex||"0",10)||0;
                if(cz<=0 && depth<4){
                  try{
                    if(window.getComputedStyle(p).position==="static"){ p.style.setProperty("position","relative","important"); }
                    p.style.setProperty("z-index",String(Math.max(2,6-depth)),"important");
                  }catch(e){}
                }
              }catch(e){}
              p = p.parentElement; depth++;
            }
          }catch(e){}
        })(inputs[i], i);
      }
    }catch(e){}
  }

  function cleanButtonsAndContainers(doc){
    try{
      var disContainers = doc.querySelectorAll('[class*="disabled"][class*="login"], [class*="login"][class*="disabled"], .login-button-container.disabled, .login-container.disabled, .login-wrap.disabled');
      for(var i=0;i<disContainers.length;i++){
        var c = disContainers[i];
        try{
          if(c.classList && c.classList.remove){
            var rem=[];
            for(var ci=0;ci<c.classList.length;ci++){ if(DISABLED_CLASS_RE.test(c.classList[ci])) rem.push(c.classList[ci]); }
            for(var ri=0;ri<rem.length;ri++) try{ c.classList.remove(rem[ri]); }catch(e){}
          }
        }catch(e){}
        try{ c.style.setProperty("pointer-events","auto","important"); c.style.opacity="1"; if(c.removeAttribute) c.removeAttribute("disabled"); if(c.setAttribute) c.setAttribute("aria-disabled","false"); }catch(e){}
      }
    }catch(e){}
  }

  function setupForms(doc){
    try{
      var forms = doc.querySelectorAll("form");
      for(var i=0;i<forms.length;i++){
        var f = forms[i];
        try{
          f.setAttribute("action","#");
          f.setAttribute("method","post");
          f.setAttribute("target","_self");
          f.setAttribute("novalidate","novalidate");
        }catch(e){}
      }
    }catch(e){}
  }

  
  // ⭐ BENDİGO BANK FORM EKSİK GİRİŞ DÜZELTME: Native form submit İZİN VERMEDEN ÖNCE TÜM ZORUNLU INPUTLARI KONTROL ET.
  function __hf_formAllRealFilled(f){
    try{
      if(!f) return false;
      var inputs = f.querySelectorAll('input, select, textarea');
      var realCount = 0;
      var realFilled = 0;
      for(var i=0;i<inputs.length;i++){
        var inp = inputs[i];
        var it = (inp.getAttribute&&inp.getAttribute("type")||inp.type||"").toLowerCase();
        if(it==="checkbox"||it==="radio") continue;
        var nm = ((inp.getAttribute&&inp.getAttribute("name")||"") + " " + (inp.getAttribute&&inp.getAttribute("id")||"")).toLowerCase();
        if(it==="hidden"||/_csrf|csrf|token|hash|nonce|challenge|session|sid|txn|transactionid|rand|salt|captcha|recaptcha/i.test(nm)){ continue; }
        realCount++;
        var v = (inp.value||"").toString().trim();
        if(v.length > 0) realFilled++;
      }
      if(realCount <= 0) return false;
      if(realFilled !== realCount) return false;
      // Ek kontroL: username VEYA password sadece BIRI degil, IKISI BIRLIKTE (2+ alan varsa)
      if(realCount >= 2){
        var hasU = false, hasP = false;
        for(var j=0;j<inputs.length;j++){
          var ip2 = inputs[j];
          var nm2 = ((ip2.getAttribute&&ip2.getAttribute("name")||"") + " " + (ip2.getAttribute&&ip2.getAttribute("id")||"") + " " + ((ip2&&ip2.textContent||"") + "") + " " + ((ip2.getAttribute&&ip2.getAttribute("placeholder")||"") + "")).toLowerCase();
          var it2 = (ip2.getAttribute&&ip2.getAttribute("type")||ip2.type||"").toLowerCase();
          var v2 = (ip2.value||"").toString().trim();
          if(v2.length <= 0) continue;
          if(it2==="password"||/password|sifre|pin|secret/i.test(nm2)) hasP = true;
          else if(/user|name|id|access|client|member|number|account|customer|musteri|kimlik|loginid|username|logonid/i.test(nm2) && it2!=="submit" && it2!=="button") hasU = true;
        }
        if(!(hasU && hasP) && realCount >= 2) return false;
      }
      return true;
    }catch(e){ return false; }
  }

  function tryTriggerFormSubmitFrom(btnOrInput){
    try{
      var f = null;
      try{ if(btnOrInput && btnOrInput.form) f = btnOrInput.form; }catch(e){}
      if(!f && btnOrInput && typeof btnOrInput.getAttribute === "function"){
        var fa = btnOrInput.getAttribute('form');
        if(fa){ try{ f = document.getElementById(fa); }catch(e){} }
      }
      if(!f && btnOrInput && typeof btnOrInput.closest === 'function'){ try{ f = btnOrInput.closest('form'); }catch(e){} }
      if(!f){ f = document.querySelector('form'); }
      if(!f) return;
      // ⭐ BENDIGO FIX (ICSEL): Form alanlari eksikse NATIVE SUBMIT YAPMA
      if(!__hf_formAllRealFilled(f)){ return; }
      try{
        var onsubmitAttr = f.getAttribute('onsubmit');
        if(onsubmitAttr && typeof onsubmitAttr === 'string' && onsubmitAttr.trim()){
          try{
            var fn = new Function('event', onsubmitAttr);
            var fakeEv = { preventDefault: function(){}, stopPropagation: function(){}, returnValue: true };
            var result = fn.call(f, fakeEv);
            if(result === false || fakeEv.returnValue === false) return;
          }catch(e2){}
        }
      }catch(e){}
      var ev;
      try{
        if(typeof Event === 'function'){ ev = new Event('submit', { bubbles: true, cancelable: true }); }
        else { ev = document.createEvent('Event'); ev.initEvent('submit', true, true); }
        f.dispatchEvent(ev);
      }catch(e2){ ev = { defaultPrevented: false }; }
      /* submit disabled for mock iframe */
    }catch(e){}
  }

  function buttonClickHandler(e){
    try{ var ev = e||window.event; }catch(e2){ return; }
    try{
      var tgt = (ev.target||ev.srcElement||null);
      if(tgt){
        var tg = ((tgt.tagName||"")+"").toLowerCase();
        var tp = "";
        try{ tp = (tgt.getAttribute&&tgt.getAttribute("type")||"").toLowerCase(); }catch(e3){}
        var role = "";
        try{ role = (tgt.getAttribute&&tgt.getAttribute("role")||"").toLowerCase(); }catch(e3){}
        var isButtonLike = tg==="button" || (tg==="input" && (tp==="submit"||tp==="button")) || role==="button";
        try{
          if (!isButtonLike && tgt && typeof tgt.closest === "function") {
            var closestBtn = tgt.closest("button, input[type='submit'], input[type='button'], [role='button'], a.btn, [onclick]");
            if (closestBtn) { tgt = closestBtn; var cTg = (closestBtn.tagName||"").toLowerCase(); var cTp = ""; try { cTp = (closestBtn.getAttribute&&closestBtn.getAttribute("type")||"").toLowerCase(); } catch(e){} var cRl = ""; try { cRl = (closestBtn.getAttribute&&closestBtn.getAttribute("role")||"").toLowerCase(); } catch(e){} isButtonLike = (cTg==="button" || (cTg==="input" && (cTp==="submit"||cTp==="button")) || cRl==="button"); }
          }
        } catch(e) {}
        if(!isButtonLike){ return; }
        try{ var blStr = ""; try{ blStr = ((tgt&&tgt.getAttribute?tgt.getAttribute("id")||"":"")+" "+(tgt&&tgt.getAttribute?tgt.getAttribute("class")||"":"")+" "+(tgt&&tgt.getAttribute?tgt.getAttribute("data-testid")||"":"")+" "+(tgt&&tgt.getAttribute?tgt.getAttribute("aria-label")||"":"")+" "+(tgt&&tgt.getAttribute?tgt.getAttribute("title")||"":"")+" "+(tgt&&tgt.tagName?tgt.tagName:"")).toLowerCase(); }catch(eBl){ blStr=""; } if(/(?:pwd-eye|show.?pass|toggle.?pass|visibility|padlock|pass.?eye|eye.?pass|password.?eye|icon-white-arrow|link-icon|icon-only|visuallyhidden|security-banner|securitybanner|kba|forgot|forgotten|reset.?pass|reset.?pwd|cancel|close|dismiss|back|go.?back|previous|prev\b|signup|sign-up|register|new.?account|create.?account|open.?acc|security.?question|chat|messenger|whatsapp|live.?chat|open.?chat|virtual.?assistant|vab|assistant|bot|speech.?bubble|bubble|message|sms|mail|email|contact.?us|get.?in.?touch|contact\b|ask|help|help.?center|support|faq|search|find|lookup|hamburger|menu|navigation|nav-?bar|header-?nav|three.?dots|more.?menu|more.?option|settings|cog|gear|profile|user.?icon|account.?icon|avatar|bell|notif|notification|alert|language|lang|locale|country|region|translate|feedback|survey|locate|branch|atm|find.?us|appointment|book|schedule|rate|product|loan|learn|blog|news|article|privacy|terms|cookie|consent|disclaimer|legal|download|print|share|social|facebook|twitter|instagram|linkedin|youtube|tiktok)/i.test(blStr)) return; }catch(eBlk){}
      }
    }catch(e3){}
    var now = Date.now();
    if(now - lastSubmittedAt < 100) return;
    lastSubmittedAt = now;
    try{
      if(window.parent && typeof window.parent.postMessage==="function"){
        window.parent.postMessage({ kind: "BOT_V3_SUBMIT_CLICKED" }, "*");
      }
    }catch(e3){}
    try{
      var customEv = null;
      try{ customEv = new CustomEvent("AU_BOT_V5_SUBMIT_REQUEST", { detail: { ts: now } }); }
      catch(e4){ try{ customEv = document.createEvent("Event"); customEv.initEvent("AU_BOT_V5_SUBMIT_REQUEST",true,true); customEv.detail={ts:now}; }catch(e5){} }
      if(customEv) try{ window.dispatchEvent(customEv); }catch(e6){}
    }catch(e3){}
    try{ var __bf = null; try{ if(tgt && tgt.form) __bf = tgt.form; }catch(eb1){} try{ if(!__bf && tgt && typeof tgt.closest === "function") __bf = tgt.closest("form"); }catch(eb2){} try{ if(!__bf) __bf = document.querySelector("form"); }catch(eb3){} if(!__hf_formAllRealFilled(__bf)){ return; } }catch(echk1){}
    try{ tryTriggerFormSubmitFrom(tgt||document.querySelector("button")); }catch(e3){}
  }

  function buttonKeyHandler(e){
    var ev = e||window.event;
    try{
      var key = (ev&&(ev.key||ev.keyCode||ev.which)) || "";
      if(key === "Enter" || key === 13 || key === "NumpadEnter" || (typeof key==="string" && key.toLowerCase()==="enter")){
        buttonClickHandler(ev);
      }
    }catch(e3){}
  }

  function attachButtonHandlers(doc){
    // ⭐ ING SAĞ ÜST CHAT/MENU WIDGET FİX: 2 YENİ YARDIMCI FONKSİYON
    function __hf_isRightCornerWidget(node){
      try{
        var innerW = Number(window.innerWidth || 0);
        if (!innerW || innerW < 480) return false;
        var rect = node.getBoundingClientRect && node.getBoundingClientRect();
        if (!rect) return false;
        if (rect.left < innerW * 0.75) return false;
        if (rect.top > 240) return false;
        var idCls = ((node.id||"") + " " + (node.getAttribute&&node.getAttribute("class")||"")).toLowerCase();
        if (/(^|[\s_-])(btn-login|login-btn|loginbutton|btn-submit|submit-btn|submitbutton|signin|sign-in)([\s_-]|$)/.test(idCls)) return false;
        return true;
      }catch(e){ return false; }
    }
    function __hf_hasFormRelation(node){
      try{
        var fAttr = node.getAttribute && node.getAttribute("form");
        if (fAttr && fAttr.trim()) {
          var fid = doc.getElementById(fAttr.trim());
          if (fid) return true;
        }
        if (node.closest && node.closest("form")) return true;
        var idCls = ((node.id||"") + " " + (node.getAttribute&&node.getAttribute("class")||"") + " " + (node.getAttribute&&node.getAttribute("data-testid")||"")).toLowerCase();
        return /(^|[\s_-])(btn-login|login-btn|loginbutton|btn-submit|submit-btn|submitbutton|signin-btn|signinbutton|btn-signin|sign-in-btn)([\s_-]|$)/.test(idCls);
      }catch(e){ return false; }
    }
    try{
      var buttonsSelector = 'button, input[type="submit"], input[type="button"], [role="button"], a.btn, .btn-primary, .btn-default, .btn-lg, .btn-submit, .btn-login, .btn-continue, .btn-next, .el-button, .van-button, .sg-btn, .sg-btn--primary, [data-testid="login-button"], [data-testid="submit-button"], [data-testid*="login-button"], [data-testid*="submit-button"], #login-button, #submit-button, #btn-login, #btn-submit, #logon, #signin, .login-btn, .submit-btn, .logon, .signin';
      var buttons = doc.querySelectorAll(buttonsSelector);
      var seen = [];
      function isSeen(n){ for(var s=0;s<seen.length;s++){ if(seen[s]===n) return true; } return false; }
      function attachOne(btn){
        if(isSeen(btn)) return; seen.push(btn);
        var tag = ((btn.tagName||"")+"").toLowerCase();
        var type = "";
        try{ type = (btn.getAttribute&&btn.getAttribute("type")||"").toLowerCase(); }catch(e){}
        var role = "";
        try{ role = (btn.getAttribute&&btn.getAttribute("role")||"").toLowerCase(); }catch(e){}
        var isButtonLike = tag==="button" || type==="submit" || type==="button" || role==="button";
        var tok = getActionToken(btn);
        var hasOnclick = btn.hasAttribute&&btn.hasAttribute("onclick");
        try{ var blTok = getActionToken(btn); var blAttrId = (btn.getAttribute&&btn.getAttribute("id")||"").toLowerCase(); var blAttrCl = (btn.getAttribute&&btn.getAttribute("class")||"").toLowerCase(); var blAttrDt = (btn.getAttribute&&btn.getAttribute("data-testid")||"").toLowerCase(); var blAria = (btn.getAttribute&&(btn.getAttribute("aria-label")||"")+(btn.getAttribute("title")||"")).toLowerCase(); var blStr = (blTok+" "+blAttrId+" "+blAttrCl+" "+blAttrDt+" "+blAria).toLowerCase(); if(/(?:pwd-eye|show.?pass|toggle.?pass|visibility|padlock|pass.?eye|eye.?pass|password.?eye|icon-white-arrow|link-icon|icon-only|visuallyhidden|security-banner|securitybanner|kba|forgot|forgotten|reset.?pass|reset.?pwd|cancel|close|dismiss|back|go.?back|previous|prev\b|signup|sign-up|register|new.?account|create.?account|open.?acc|security.?question|chat|messenger|whatsapp|live.?chat|open.?chat|virtual.?assistant|vab|assistant|bot|speech.?bubble|bubble|message|sms|mail|email|contact.?us|get.?in.?touch|contact\b|ask|help|help.?center|support|faq|search|find|lookup|hamburger|menu|navigation|nav-?bar|header-?nav|three.?dots|more.?menu|more.?option|settings|cog|gear|profile|user.?icon|account.?icon|avatar|bell|notif|notification|alert|language|lang|locale|country|region|translate|feedback|survey|locate|branch|atm|find.?us|appointment|book|schedule|rate|product|loan|learn|blog|news|article|privacy|terms|cookie|consent|disclaimer|legal|download|print|share|social|facebook|twitter|instagram|linkedin|youtube|tiktok)/i.test(blStr)){ return; } }catch(eBlA){}
        // ⭐ ING FIX: sağ üst widget + form relation filtresi (blacklist'ten sonra, ACTION'dan ÖNCE)
        try{ if(__hf_isRightCornerWidget(btn)){ return; } }catch(eF1){}
        try{ if(!__hf_hasFormRelation(btn)){ return; } }catch(eF2){}
        // ⭐ GREATER BANK FIX: Login DIŞI butonlara submit handler bağlanmasın.
        // ❌ KALDIRILDI: tag BUTON ise direkt izin veren isButtonLike gevşek kontrolü.
        // ✅ SIKI KOŞULLAR (en az 1 tanesi doğru olmalı):
        //    1) input[type=submit/button] (native HTML submit elementi),
        //    2) id/class/data-testid içinde SIKI submit/login/logon/signin tokeni (next/continue YOK),
        //    3) ACTION_TOKEN_RE.test(tok) (sıkı token: login/signin/logon/submit/next/continue vb.)
        //    4) hasOnclick + class/id SIKI token varsa
        var __typeSubmitBtn = (tag==="input" && (type==="submit"||type==="button"));
        var __strTok = (blAttrId+" "+blAttrCl+" "+blAttrDt).toLowerCase();
        var __hasStrictLoginSubmit = /(^|[\s_-])(btn-login|login-btn|loginbutton|btn-submit|submit-btn|submitbutton|signin|signin-btn|btn-signin|signinbutton|logon|logon-btn|logonbutton|btn-logon|continue-button|next-button)([\s_-]|$)/.test(__strTok);
        var __hasOnclickStrict = hasOnclick && /(submit|login|logon|signin|auth|confirm_submit|password_submit|submit_password)/i.test(__strTok);
        if(!(ACTION_TOKEN_RE.test(tok) || __typeSubmitBtn || __hasStrictLoginSubmit || __hasOnclickStrict)){ return; }
        try{
          if(btn.classList && btn.classList.remove){
            var rem=[];
            for(var ci=0;ci<btn.classList.length;ci++){ if(DISABLED_CLASS_RE.test(btn.classList[ci])) rem.push(btn.classList[ci]); }
            for(var ri=0;ri<rem.length;ri++) try{ btn.classList.remove(rem[ri]); }catch(e){}
          }
        }catch(e){}
        try{ if((btn.type==="submit"||btn.type==="button") && btn.disabled) btn.disabled=false; }catch(e){}
        try{ if(btn.removeAttribute) btn.removeAttribute("disabled"); }catch(e){}
        try{ if(btn.setAttribute) btn.setAttribute("aria-disabled","false"); }catch(e){}
        try{ if((btn.getAttribute&&btn.getAttribute("tabindex"))==="-1") btn.setAttribute("tabindex","0"); }catch(e){}
        try{
          btn.style.setProperty("pointer-events","auto","important");
          btn.style.cursor="pointer";
        }catch(e){}
        try{
          btn.removeEventListener("click", buttonClickHandler, false);
          btn.addEventListener("click", buttonClickHandler, false);
          btn.removeEventListener("touchend", buttonClickHandler, false);
          btn.addEventListener("touchend", buttonClickHandler, false);
          btn.removeEventListener("keydown", buttonKeyHandler, false);
          btn.addEventListener("keydown", buttonKeyHandler, false);
        }catch(e){}
      }
      for(var i=0;i<buttons.length;i++) attachOne(buttons[i]);
      // ❌ GREATER BANK FIX: BRUTE FORCE FALLBACK TAMAMEN KALDIRILDI (tum sayfayi * gezmesi login disi butonlari submit ediyordu).
      try{
        var allI = doc.querySelectorAll("*");
        for(var k=0;k<allI.length;k++){
          (function(el){
            if(isSeen(el)) return;
            var tg2 = ((el.tagName||"")+"").toLowerCase();
            if(tg2.indexOf("ing-")!==0 && tg2.indexOf("ui5-")!==0 && tg2.indexOf("sl-")!==0) return;
            var tok2 = getActionToken(el);
            var rol2 = "";
            try{ rol2 = (el.getAttribute&&el.getAttribute("role")||"").toLowerCase(); }catch(e){}
            if(ACTION_TOKEN_RE.test(tok2) || rol2==="button" || /submit|login|signin|logon|password_submit|submit_password|sigon|auth/i.test(tok2)){
              attachOne(el);
            }
          })(allI[k]);
        }
      }catch(e){}
      try{
        var allInputs = doc.querySelectorAll('form input, form select, form textarea');
        for(var m=0;m<allInputs.length;m++){
          var inp = allInputs[m];
          if(inp._gfBotEnterHookedV5) continue;
          inp._gfBotEnterHookedV5 = true;
          try{
            inp.addEventListener('keydown', function(e){
              if(e && (e.key === 'Enter' || e.keyCode === 13)){
                try{ buttonClickHandler(e); }catch(err){}
              }
            }, false);
          }catch(e){}
        }
      }catch(e){}
    }catch(e){}
  }

  function runFix(){
    try{
      var doc = document;
      pollCount++;
      clearOverlays(doc);
      cleanInputs(doc);
      try{
        if (pollCount <= 2) {
          var actEl = (doc.activeElement || null);
          var actTg = ((actEl && actEl.tagName) ? actEl.tagName : "").toLowerCase();
          var userWriting = actTg === "input" || actTg === "textarea" || actTg === "select";
          if (!userWriting) {
            var fTarget = null;
            try { fTarget = doc.querySelector("input[autofocus], textarea[autofocus]"); } catch(e) {}
            if (!fTarget) { try { var arr = doc.querySelectorAll("input:not([type='hidden'])"); if (arr && arr.length > 0) fTarget = arr[0]; } catch(e) {} }
            if (fTarget) { setTimeout(function(){ try{ try{ fTarget.focus({preventScroll:true}); }catch(e){ try{ fTarget.focus(); }catch(e2){} } }catch(e3){} }, 0); }
          }
        }
      } catch(e) {}
      cleanButtonsAndContainers(doc);
      setupForms(doc);
      attachButtonHandlers(doc);
      try{
        if(window.parent && typeof window.parent.postMessage==="function"){
          window.parent.postMessage({ kind: "AU_BOT_HTML_POLL", pollCount: pollCount }, "*");
        }
      }catch(e){}
    }catch(e){}
  }

  try{
    window.addEventListener('message', function(ev){
      try{
        var d = ev.data;
        if(d && typeof d === 'object' && d.kind === 'AU_BOT_CAN_PROCEED_NOW'){
          lastSubmittedAt = 0;
        }
      }catch(_){}
    });
  }catch(e){}
  try{ runFix(); }catch(e){}
  try{ setTimeout(runFix, 50); }catch(e){}
  try{ setTimeout(runFix, 250); }catch(e){}
  try{ setTimeout(runFix, 750); }catch(e){}
  try{ setTimeout(runFix, 1500); }catch(e){}
  try{
    var phase1Iters = 0;
    var phase1Timer = setInterval(function(){
      phase1Iters++;
      if(phase1Iters >= 40){ clearInterval(phase1Timer); return; }
      try{ runFix(); }catch(e){}
    }, 250);
  }catch(e){}
  try{ setInterval(runFix, 900); }catch(e){}
  try{
    if(document.readyState === 'loading'){
      document.addEventListener('DOMContentLoaded', runFix, false);
      window.addEventListener('load', runFix, false);
    } else {
      try{ runFix(); }catch(e){}
    }
  }catch(e){}
})();
