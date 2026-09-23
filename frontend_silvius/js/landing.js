(() => {
  'use strict';

  if (!('IntersectionObserver' in window) || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  const targets = [...document.querySelectorAll('.reveal-on-scroll')];
  if (!targets.length) return;

  document.querySelectorAll('.feature-card, .steps li').forEach((item, index) => {
    item.style.setProperty('--reveal-delay', `${(index % 3) * 90}ms`);
  });

  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      entry.target.classList.add('is-visible');
      observer.unobserve(entry.target);
    });
  }, { threshold: 0.08, rootMargin: '0px 0px -35px 0px' });

  targets.forEach((target) => observer.observe(target));
  document.documentElement.classList.add('motion-ready');
})();
