/*
 * Comme dans Claude : sur mobile, le grand titre du tiroir disparaît quand on fait
 * défiler la liste des conversations, et revient en haut de la liste.
 */
(function () {
  var COLLAPSE_AT = 40;
  var EXPAND_AT = 4;
  var CLASS_NAME = 'lc-title-collapsed';

  function getNav() {
    return document.getElementById('chat-history-nav');
  }

  function getTitle(nav) {
    var header = nav && nav.previousElementSibling;
    return header ? header.querySelector('h1') : null;
  }

  document.addEventListener(
    'scroll',
    function (event) {
      var nav = getNav();
      var target = event.target;
      if (!nav || !target || target === document || !nav.contains(target)) {
        return;
      }
      var title = getTitle(nav);
      if (!title) {
        return;
      }
      var collapsed = title.classList.contains(CLASS_NAME);
      var top = target.scrollTop;
      var scrollable = target.scrollHeight - target.clientHeight;
      if (!collapsed && top > COLLAPSE_AT && scrollable > 160) {
        title.classList.add(CLASS_NAME);
      } else if (collapsed && top < EXPAND_AT) {
        title.classList.remove(CLASS_NAME);
      }
    },
    true,
  );

  /* Si la liste est recréée (retour en haut sans événement de défilement), on remet le titre. */
  function sync() {
    var nav = getNav();
    var title = getTitle(nav);
    var scroller = nav && nav.querySelector('.overflow-y-auto');
    if (title && scroller && title.classList.contains(CLASS_NAME) && scroller.scrollTop < EXPAND_AT) {
      title.classList.remove(CLASS_NAME);
    }
  }
  document.addEventListener('click', sync, true);
  document.addEventListener('touchend', sync, true);
})();
