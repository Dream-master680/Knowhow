/* ═══════════════════════════════════════════════════════════════════
   KnowHow 设置中心 settings.js（2026-08-24）
   功能：打开/关闭设置面板（头像下拉 → ⚙️ 设置）、主题色卡、护眼开关、字号三档、退出登录。
   依赖：index.html 内联脚本已提供 KH.applyTheme / KH.setEyeCare / KH.setFont；
         app.js 已提供 KH.logout。
   持久化：kh_theme / kh_eyecare('0'|'1') / kh_font('std'|'lg'|'xl')，首帧前由内联脚本恢复。
   ═══════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  var KH = window.KH = window.KH || {};
  var panel = null;

  function root() { return document.documentElement; }
  function q(s) { return document.querySelector(s); }

  function syncUI() {
    var theme = root().getAttribute('data-theme') || 'deep-blue';
    var radios = document.querySelectorAll('input[name="khTheme"]');
    for (var i = 0; i < radios.length; i++) {
      radios[i].checked = (radios[i].value === theme);
    }
    var eyeOn = root().getAttribute('data-eyecare') === 'on';
    var sw = q('#eyeCareSwitch');
    if (sw) sw.setAttribute('aria-checked', eyeOn ? 'true' : 'false');
    var font = root().getAttribute('data-font') || 'std';
    var opts = document.querySelectorAll('.font-opt');
    for (var j = 0; j < opts.length; j++) {
      opts[j].classList.toggle('active', opts[j].getAttribute('data-font-val') === font);
    }
  }

  KH.openSettings = function () {
    if (!panel) panel = document.getElementById('settingsPanel');
    if (!panel) return;
    syncUI();
    panel.hidden = false;
    panel.classList.add('open');
    document.body.classList.add('settings-open');
  };

  KH.closeSettings = function () {
    if (!panel) return;
    panel.classList.remove('open');
    document.body.classList.remove('settings-open');
    var t = setTimeout(function () { if (panel) panel.hidden = true; }, 160);
    if (t && window.__khCloseTimer) clearTimeout(window.__khCloseTimer);
    window.__khCloseTimer = t;
  };

  function bind() {
    panel = document.getElementById('settingsPanel');
    if (!panel) return;

    // 关闭：× / 遮罩 / Esc / 路由变化
    var closeBtn = q('.settings-close');
    if (closeBtn) closeBtn.addEventListener('click', KH.closeSettings);
    panel.addEventListener('click', function (e) { if (e.target === panel) KH.closeSettings(); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !panel.hidden) KH.closeSettings();
    });
    window.addEventListener('hashchange', function () {
      if (!panel.hidden) KH.closeSettings();
    });

    // 主题色卡：实时生效不关面板
    var radios = document.querySelectorAll('input[name="khTheme"]');
    for (var i = 0; i < radios.length; i++) {
      radios[i].addEventListener('change', function () {
        if (KH.applyTheme) KH.applyTheme(this.value);
        syncUI();
      });
    }

    // 护眼开关
    var sw = q('#eyeCareSwitch');
    if (sw) sw.addEventListener('click', function () {
      var on = root().getAttribute('data-eyecare') !== 'on';
      if (KH.setEyeCare) KH.setEyeCare(on);
      syncUI();
    });

    // 字号三档
    var opts = document.querySelectorAll('.font-opt');
    for (var j = 0; j < opts.length; j++) {
      opts[j].addEventListener('click', function () {
        if (KH.setFont) KH.setFont(this.getAttribute('data-font-val'));
        syncUI();
      });
    }

    // 退出登录
    var lo = q('#settingsLogout');
    if (lo) lo.addEventListener('click', function () {
      if (window.KH.logout) window.KH.logout();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind);
  } else {
    bind();
  }
})();
