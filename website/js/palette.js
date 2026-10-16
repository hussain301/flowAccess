// Dynamic accent palette — a different theme on every visit.
// Sets --pa* CSS vars on <body>; works on any page that includes this file.
(function vuPalette() {
  var palettes = [
    { a:'#00e676', hover:'#00c968', light:'#7dffce', rgb:'0,230,118',   grad:'linear-gradient(135deg,#00e676,#00e5a0 60%,#7dffce)' },
    { a:'#22d3ee', hover:'#0fb5d1', light:'#a5f3fc', rgb:'34,211,238',   grad:'linear-gradient(135deg,#22d3ee,#67e8f9 60%,#a5f3fc)' },
    { a:'#a78bfa', hover:'#8b5cf6', light:'#ddd6fe', rgb:'167,139,250',  grad:'linear-gradient(135deg,#a78bfa,#c4b5fd 60%,#ede9fe)' },
    { a:'#fbbf24', hover:'#f59e0b', light:'#fde68a', rgb:'251,191,36',    grad:'linear-gradient(135deg,#fbbf24,#fcd34d 60%,#fef3c7)' },
    { a:'#f472b6', hover:'#ec4899', light:'#fbcfe8', rgb:'244,114,182',  grad:'linear-gradient(135deg,#f472b6,#f9a8d4 60%,#fce7f3)' },
    { a:'#60a5fa', hover:'#3b82f6', light:'#bfdbfe', rgb:'96,165,250',    grad:'linear-gradient(135deg,#60a5fa,#93c5fd 60%,#dbeafe)' }
  ];
  var p = palettes[Math.floor(Math.random() * palettes.length)];
  var s = document.body.style;
  s.setProperty('--pa', p.a);
  s.setProperty('--pa-hover', p.hover);
  s.setProperty('--pa-light', p.light);
  s.setProperty('--pa-rgb', p.rgb);
  s.setProperty('--pa-grad', p.grad);
})();
