const V='vm2026-v1';
const STATIC=[
  '/','/index.html','/sw.js','/manifest.json',
  '/swos-players.js','/stadium.png','/trophy.png',
  '/favicon-32.png','/favicon-16.png',
  '/fonts/d85064eaed4b8683-s.woff2','/fonts/db234bd00cda6a96-s.p.woff2',
  '/fonts/751eccb0decf5e18-s.woff2','/fonts/f6590a0f07a97750-s.woff2','/fonts/b7bd7951037de757-s.p.woff2'
];

self.addEventListener('install',e=>{
  e.waitUntil(caches.open(V).then(c=>c.addAll(STATIC)));
  self.skipWaiting();
});

self.addEventListener('activate',e=>{
  e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==V).map(k=>caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch',e=>{
  const url=new URL(e.request.url);
  if(url.hostname!==self.location.hostname){
    e.respondWith(fetch(e.request).catch(()=>new Response('',{status:503})));
    return;
  }
  e.respondWith(
    caches.match(e.request).then(cached=>{
      const fresh=fetch(e.request).then(resp=>{
        if(resp.status===200){const cl=resp.clone();caches.open(V).then(c=>c.put(e.request,cl))}
        return resp;
      }).catch(()=>cached||new Response('',{status:503}));
      return cached||fresh;
    })
  );
});
