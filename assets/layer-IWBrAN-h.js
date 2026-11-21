import{i as et}from"./maplibre-gl-B8lVyYEz.js";const $=4.62,B=$/2,tt=1.94,at=.3,T=.37,G=.27,q=[1.42,-1.4],O=(e,a,c)=>Math.min(c,Math.max(a,e)),y=(e,a,c)=>{const s=O((c-e)/(a-e),0,1);return s*s*(3-2*s)},C=(e,a)=>Math.sign(e)*Math.abs(e)**(2/a);function H(e){const a=e/B,c=a>0?4.2:6;return tt/2*(1-Math.abs(a)**c)**(1/c)}function F(e){const a=.78+.22*y(2.3,1.15,e),c=1.02-.08*y(-2.05,-2.31,e);return e>0?Math.min(a,1+.02*(1-e/B)):c}function I(e){return at+.08*y(1.9,2.31,e)+.12*y(-1.95,-2.31,e)}function st(e,a){let c=0;for(const s of q){const n=Math.hypot(e-s,a-T);c=Math.max(c,1-y(T+.05,T+.13,n))}return c}function rt(e,a){let c=0;for(const s of q)c=Math.max(c,Math.exp(-(((e-s)/.55)**2)));return .035*c*Math.exp(-(((a-.72)/.22)**2))}function j(e,a,c,s,n){const u=a.length,f=a[0].length,i=(v,r)=>a[O(v,0,u-1)][c?(r+f)%f:O(r,0,f-1)],h=(v,r)=>{const m=i(v+1,r),l=i(v-1,r),o=i(v,r+1),t=i(v,r-1),b=[m[0]-l[0],m[1]-l[1],m[2]-l[2]],g=[o[0]-t[0],o[1]-t[1],o[2]-t[2]];let A=[b[1]*g[2]-b[2]*g[1],b[2]*g[0]-b[0]*g[2],b[0]*g[1]-b[1]*g[0]];const x=i(v,r),P=n(v);A[0]*(x[0]-P[0])+A[1]*(x[1]-P[1])+A[2]*(x[2]-P[2])<0&&(A=[-A[0],-A[1],-A[2]]);const L=Math.hypot(...A)||1;return[A[0]/L,A[1]/L,A[2]/L]},p=a.map((v,r)=>v.map((m,l)=>h(r,l))),d=c?f:f-1;for(let v=0;v<u-1;v++)for(let r=0;r<d;r++){const m=(r+1)%f,l=[a[v][r],a[v+1][r],a[v+1][m],a[v][m]],o=[p[v][r],p[v+1][r],p[v+1][m],p[v][m]],t=[(l[0][0]+l[2][0])/2,(l[0][1]+l[2][1])/2,(l[0][2]+l[2][2])/2],b=[(o[0][0]+o[2][0])/2,(o[0][1]+o[2][1])/2,(o[0][2]+o[2][2])/2],g=s(t,b);e.triN(l[0],l[1],l[2],o[0],o[1],o[2],g),e.triN(l[0],l[2],l[3],o[0],o[2],o[3],g)}}function K(e,a,c,s=2.2){const n=[];for(let u=0;u<=c;u++){const f=u/c,i=.5-.5*Math.cos(Math.PI*f);n.push(e+(a-e)*(f+(i-f)*(s-1)*.5))}return n}function it(){const e=new ot,a=30,c=K(-B+.004,B-.004,34),s=c.map(r=>{const m=H(r),l=I(r),o=F(r),t=r/B,b=t>0?7:12,g=(1-Math.abs(t)**b)**(1/b),A=(l+o)/2,x=(o-l)/2*(.35+.65*g),P=[];for(let L=0;L<a;L++){const w=L/a*Math.PI*2,_=A+x*C(Math.sin(w),4.2);let N=m*C(Math.cos(w),3.4);N*=1+rt(r,_);const U=st(r,_);U>0&&Math.abs(N)>.3&&(N=Math.sign(N)*(Math.abs(N)-.17*U)),P.push([N,r,_])}return P});j(e,s,!0,(r,m)=>{const[,l,o]=r;return o<I(l)+.05||m[2]<-.5&&o<.6?M.trim:M.body},r=>[0,c[r],(I(c[r])+F(c[r]))/2]);for(const r of[0,s.length-1]){const m=s[r],l=[0,m[0][1],(I(m[0][1])+F(m[0][1]))/2],o=[0,r===0?-1:1,0];for(let t=0;t<m.length;t++){const b=Math.min(m[t][2],m[(t+1)%m.length][2])<I(m[0][1])+.1;e.triN(l,m[t],m[(t+1)%m.length],o,o,o,b?M.trim:M.body)}}const n=-2.02,u=1.18,f=K(n,u,22,1.6),i=r=>1.6-.04*((r+.4)/1.6)**2,h=r=>{const m=y(u,.05,r),l=.25+.75*y(n,-1.25,r);return Math.max(.004,(i(r)-F(r))*m*l)},p=16,d=f.map(r=>{const m=F(r)-.005,l=h(r),o=H(r)*.93,t=[];for(let b=0;b<=p;b++){const g=b/p*Math.PI,A=C(Math.cos(g),3.2),x=Math.abs(C(Math.sin(g),3.2)),P=1-.17*x;t.push([o*P*A,r,m+l*x])}return t});j(e,d,!1,(r,m)=>{const[l,o,t]=r,b=(o-n)/(u-n),g=H(o)*.93*.83;return m[2]>.82&&Math.abs(l)>g*.82&&b>.12&&b<.82?M.body:m[2]>.82&&b>.12&&b<.84?M.roof:o>-.12&&o<.02&&Math.abs(m[0])>.6&&t<1.5?M.trim:M.glass},r=>[0,f[r],F(f[r])]);const v=(r,m)=>{let l=0;for(let o=s.length-1;o>0;o--){const t=s[o];if(t.some(g=>Math.abs(g[2]-m)<.06&&Math.abs(g[0])>=Math.abs(r))){l=t[0][1];break}}return l};for(const r of[-1,1]){const m=[];for(let l=0;l<=6;l++){const o=r*(.12+.7*l/6);m.push([o,v(o,.73)+.012,.73])}for(let l=0;l<m.length-1;l++){const o=m[l],t=m[l+1],b=[0,1,0];e.triN([o[0],o[1],o[2]-.016],[t[0],t[1],t[2]-.016],[t[0],t[1],t[2]+.016],b,b,b,M.headlight),e.triN([o[0],o[1],o[2]-.016],[t[0],t[1],t[2]+.016],[o[0],o[1],o[2]+.016],b,b,b,M.headlight)}}for(const r of q)for(const m of[-1,1]){const l=H(r);e.wheelEv(m*(l-.1-G/2),r,T,T,G)}return e.build($,tt+.07,i(0))}const M={body:0,glass:1,tire:2,rim:3,headlight:4,taillight:5,trim:6,roof:7},Z={[M.body]:[1,1,1,0],[M.glass]:[.09,.12,.16,0],[M.tire]:[.07,.07,.08,0],[M.rim]:[.62,.65,.69,0],[M.headlight]:[1,.97,.86,1],[M.taillight]:[.95,.13,.12,1],[M.trim]:[.12,.13,.15,0],[M.roof]:[.05,.06,.08,0]};class ot{pos=[];nor=[];mat=[];tri(a,c,s,n){const u=[c[0]-a[0],c[1]-a[1],c[2]-a[2]],f=[s[0]-a[0],s[1]-a[1],s[2]-a[2]];let i=[u[1]*f[2]-u[2]*f[1],u[2]*f[0]-u[0]*f[2],u[0]*f[1]-u[1]*f[0]];const h=Math.hypot(...i)||1;i=[i[0]/h,i[1]/h,i[2]/h];for(const p of[a,c,s])this.pos.push(...p),this.nor.push(...i),this.mat.push(n)}triN(a,c,s,n,u,f,i){for(const[h,p]of[[a,n],[c,u],[s,f]])this.pos.push(...h),this.nor.push(...p),this.mat.push(i)}wheelEv(a,c,s,n,u,f=30){const i=a>0?1:-1,h=a+i*u/2,p=a-i*u/2,d=(m,l,o)=>[m,c+Math.cos(l)*o,s+Math.sin(l)*o],v=(m,l=0,o=1)=>{const t=Math.hypot(l,o)||1;return[l/t,Math.cos(m)*o/t,Math.sin(m)*o/t]},r=[i,0,0];for(let m=0;m<f;m++){const l=m/f*Math.PI*2,o=(m+1)/f*Math.PI*2,t=h-i*.05;this.triN(d(p,l,n),d(p,o,n),d(t,o,n),v(l),v(o),v(o),M.tire),this.triN(d(p,l,n),d(t,o,n),d(t,l,n),v(l),v(o),v(l),M.tire),this.triN(d(t,l,n),d(t,o,n),d(h,o,n*.9),v(l,i*.7),v(o,i*.7),v(o,i*1.4),M.tire),this.triN(d(t,l,n),d(h,o,n*.9),d(h,l,n*.9),v(l,i*.7),v(o,i*1.4),v(l,i*1.4),M.tire),this.triN(d(h,l,n*.9),d(h,o,n*.9),d(h,o,n*.7),r,r,r,M.tire),this.triN(d(h,l,n*.9),d(h,o,n*.7),d(h,l,n*.7),r,r,r,M.tire);const b=m*5/f%1<.4,g=h-i*.012;this.triN(d(g,l,n*.7),d(g,o,n*.7),d(g,o,n*.6),r,r,r,M.rim),this.triN(d(g,l,n*.7),d(g,o,n*.6),d(g,l,n*.6),r,r,r,M.rim);const A=b?M.rim:M.trim;this.triN(d(g,l,n*.6),d(g,o,n*.6),d(g,o,n*.22),r,r,r,A),this.triN(d(g,l,n*.6),d(g,o,n*.22),d(g,l,n*.22),r,r,r,A),this.triN(d(g,l,n*.22),d(g,o,n*.22),[g+i*.01,c,s],r,r,r,M.rim)}}quad(a,c,s,n,u){this.tri(a,c,s,u),this.tri(a,s,n,u)}box(a,c,s,n,u,f,i){const h=(p,d,v)=>[p,d,v];this.quad(h(a,s,f),h(c,s,f),h(c,n,f),h(a,n,f),i),this.quad(h(a,n,u),h(c,n,u),h(c,s,u),h(a,s,u),i),this.quad(h(a,n,u),h(a,n,f),h(c,n,f),h(c,n,u),i),this.quad(h(c,s,u),h(c,s,f),h(a,s,f),h(a,s,u),i),this.quad(h(c,n,u),h(c,n,f),h(c,s,f),h(c,s,u),i),this.quad(h(a,s,u),h(a,s,f),h(a,n,f),h(a,n,u),i)}extrude(a,c,s){const n=c/2,u=a.map(([i,h])=>[-n,i,h]),f=a.map(([i,h])=>[n,i,h]);for(let i=1;i<a.length-1;i++)this.tri(f[0],f[i],f[i+1],s),this.tri(u[0],u[i+1],u[i],s);for(let i=0;i<a.length;i++){const h=(i+1)%a.length;this.quad(u[i],u[h],f[h],f[i],s)}}wheel(a,c,s,n,u,f=12){const i=a-u/2,h=a+u/2,p=a>0?h:i;for(let d=0;d<f;d++){const v=d/f*Math.PI*2,r=(d+1)/f*Math.PI*2,m=(l,o,t=n)=>[l,c+Math.cos(o)*t,s+Math.sin(o)*t];this.quad(m(i,v),m(i,r),m(h,r),m(h,v),M.tire),p===h?this.tri([h,c,s],m(h,v,n*.62),m(h,r,n*.62),M.rim):this.tri([i,c,s],m(i,r,n*.62),m(i,v,n*.62),M.rim)}}build(a,c,s){return{positions:new Float32Array(this.pos),normals:new Float32Array(this.nor),materials:new Float32Array(this.mat),length:a,width:c,height:s}}}function ct(){const e=new ot,a=1.9;e.extrude([[-2.25,.36],[2.25,.36],[2.3,.62],[2.22,.86],[1.25,1.06],[-2.12,1.08],[-2.26,.95]],a,M.body),e.extrude([[-2.02,1.06],[1.2,1.06],[.42,1.6],[-1.86,1.62]],1.72,M.glass),e.box(-.82,.82,-1.86,.4,1.6,1.67,M.body),e.box(-.8,-.72,-1.7,.2,1.67,1.71,M.trim),e.box(.72,.8,-1.7,.2,1.67,1.71,M.trim);for(const s of[-1,1])e.box(s*.87-.02,s*.87+.02,-.55,-.42,1.06,1.6,M.body),e.box(s*.86-.02,s*.86+.02,-1.95,-1.7,1.06,1.6,M.body);e.box(-.93,.93,2.02,2.32,.34,.5,M.trim),e.box(-.93,.93,-2.3,-2,.34,.52,M.trim),e.box(-.97,-.93,-1.2,1.2,.34,.46,M.trim),e.box(.93,.97,-1.2,1.2,.34,.46,M.trim);const c=(s,n,u)=>{u(s,n),u(-n,-s)};c(.6,.86,(s,n)=>e.box(s,n,2.24,2.31,.72,.8,M.headlight)),c(.6,.88,(s,n)=>e.box(s,n,-2.28,-2.22,.82,.93,M.taillight)),e.box(-.6,.6,-2.27,-2.23,.86,.89,M.taillight);for(const s of[1.42,-1.38])for(const n of[-1,1])e.wheel(n*.83,s,.36,.36,.26);return e.build(4.6,a,1.71)}const ft={ev:{name:"Электрокроссовер",build:()=>it()},suv:{name:"Кроссовер (простой)",build:ct}},ht=`
attribute vec3 aPos; attribute vec3 aNor; attribute float aMat;
uniform mat4 uMvp;
varying vec3 vNor; varying float vMat; varying vec3 vPos;
void main(){ vNor = aNor; vMat = aMat; vPos = aPos; gl_Position = uMvp * vec4(aPos, 1.0); }`,lt=`
precision mediump float;
varying vec3 vNor; varying float vMat; varying vec3 vPos;
uniform vec3 uBody; uniform vec4 uMats[8]; uniform vec3 uView; uniform float uNight;
vec3 env(vec3 r){
  vec3 sky = mix(vec3(0.62, 0.70, 0.80), vec3(0.95, 0.97, 1.0), smoothstep(0.0, 0.8, r.z));
  vec3 ground = vec3(0.16, 0.17, 0.19);
  return mix(ground, sky, smoothstep(-0.15, 0.12, r.z));
}
void main(){
  vec3 n = normalize(vNor);
  int m = int(vMat + 0.5);
  vec4 mc = uMats[0];
  for (int i = 1; i < 8; i++) if (i == m) mc = uMats[i];
  vec3 base = m == 0 ? uBody : mc.rgb;
  // Светодиодные полосы рисуются по поверхности кузова (чётко при любой сетке): фонари сзади во всю ширину, фары спереди.
  if (m == 0) {
    if ((n.y < -0.35 && vPos.z > 0.855 && vPos.z < 0.905) || (vPos.y < -1.98 && abs(vPos.x) > 0.6 && vPos.z > 0.8 && vPos.z < 0.95 && n.y < 0.2)) { mc = uMats[5]; base = mc.rgb; }
    else if (n.y > 0.3 && vPos.z > 0.712 && vPos.z < 0.742 && abs(vPos.x) < 0.88) { mc = uMats[4]; base = mc.rgb; }
    else {
      // Тёмные накладки: арки колёс (оси 1.42 и −1.40 м, радиус 0.37) и пороги.
      float arch = min(length(vec2(vPos.y - 1.42, vPos.z - 0.37)), length(vec2(vPos.y + 1.40, vPos.z - 0.37)));
      if ((arch < 0.5 && abs(n.x) > 0.25) || vPos.z < 0.42) { m = 6; mc = uMats[6]; base = mc.rgb; }
    }
  }
  // Остекление: стойка D цвета кузова (наклонная граница), панорамная крыша — по нормали (плавные границы).
  if (m == 1 || m == 7) {
    if (vPos.y < -1.42 - 0.35 * (vPos.z - 1.05) && abs(n.x) > 0.5 && n.z < 0.8) { m = 0; base = uBody; mc = uMats[0]; }
    else {
      // Плавный переход стекло → панорамная крыша (без «ступенек» сетки).
      float roof = smoothstep(0.78, 0.9, n.z);
      base = mix(uMats[1].rgb, uMats[7].rgb, roof);
      m = roof > 0.5 ? 7 : 1;
    }
  }
  // Фары и фонари светятся.
  if (mc.a > 0.5) { gl_FragColor = vec4(min(base * (1.15 + 0.35 * uNight) + 0.08, 1.0), 1.0); return; }
  vec3 V = normalize(uView);
  vec3 Lk = normalize(vec3(-0.35, -0.45, 0.82));
  vec3 Lf = normalize(vec3(0.6, 0.3, 0.5));
  float diff = max(dot(n, Lk), 0.0) * 0.75 + max(dot(n, Lf), 0.0) * 0.25;
  float hemi = 0.5 + 0.5 * n.z;
  float ao = mix(0.55, 1.0, smoothstep(0.25, 1.05, vPos.z));
  vec3 H = normalize(Lk + V);
  float fres = pow(1.0 - max(dot(n, V), 0.0), 3.0);
  vec3 R = reflect(-V, n);
  vec3 col;
  if (m == 0) {
    // Кузов: краска + лак — мягкий блик и отражение неба по краям.
    float spec = pow(max(dot(n, H), 0.0), 48.0) * 0.55;
    col = base * (0.24 + 0.5 * diff + 0.16 * hemi) * ao;
    col = mix(col, env(R) * 0.92, 0.06 + 0.3 * fres) + spec;
  } else if (m == 1 || m == 7) {
    // Стёкла и панорамная крыша: тёмные, с отражением неба.
    float spec = pow(max(dot(n, H), 0.0), 80.0) * 0.9;
    col = base * (0.5 + 0.5 * diff) + env(R) * (m == 7 ? 0.28 : 0.22) * (0.35 + 0.65 * fres) + spec;
  } else if (m == 3) {
    // Диски — металл.
    float spec = pow(max(dot(n, H), 0.0), 30.0) * 0.6;
    col = base * (0.35 + 0.5 * diff) + env(R) * 0.25 + spec;
  } else {
    col = base * (0.45 + 0.55 * diff) * ao + pow(max(dot(n, H), 0.0), 16.0) * 0.06;
  }
  // Ночью кузов чуть темнее и холоднее (как под лунным светом), но остаётся хорошо заметным; фары — ярче.
  col = mix(col, col * vec3(0.72, 0.78, 0.92), uNight);
  gl_FragColor = vec4(col, 1.0);
}`,ut=`
attribute vec2 aUv; uniform mat4 uMvp; varying vec2 vUv;
void main(){ vUv = aUv; gl_Position = uMvp * vec4(aUv.x * 1.35, aUv.y * 2.75, 0.02, 1.0); }`,mt=`
precision mediump float; varying vec2 vUv; uniform float uAlpha;
void main(){
  vec2 q = abs(vUv);
  float box = length(max(q - vec2(0.55, 0.7), 0.0)) + min(max(q.x - 0.55, q.y - 0.7), 0.0);
  float soft = 1.0 - smoothstep(-0.35, 0.6, box);
  float contact = 1.0 - smoothstep(-0.32, 0.02, box);
  gl_FragColor = vec4(0.0, 0.0, 0.0, uAlpha * (0.55 * soft + 0.45 * contact));
}`,dt=`
attribute vec2 aUv; uniform mat4 uMvp; uniform vec4 uRect; varying vec2 vUv;
void main(){ vUv = aUv * 0.5 + 0.5; vec2 p = mix(uRect.xy, uRect.zw, vUv); gl_Position = uMvp * vec4(p, 0.03, 1.0); }`,vt=`
precision mediump float; varying vec2 vUv; uniform float uKind; uniform float uAlpha;
void main(){
  float x = vUv.x * 2.0 - 1.0; // поперёк машинки −1…1
  float t = vUv.y;             // вдоль: фары — от бампера вперёд (0→1), огни — от кормы назад (1→0)
  if (uKind < 0.5) {
    // Ближний свет: два луча расходятся и сливаются, к краю пятна гаснут.
    float spread = 0.3 + 0.75 * t;
    float beam = max(1.0 - smoothstep(0.1 * spread, 0.7 * spread, abs(x - 0.3 * (1.0 - t))),
                     1.0 - smoothstep(0.1 * spread, 0.7 * spread, abs(x + 0.3 * (1.0 - t))));
    float a = beam * pow(1.0 - t, 1.25) * smoothstep(0.0, 0.05, t);
    gl_FragColor = vec4(vec3(1.0, 0.9, 0.68) * a * uAlpha, 1.0);
  } else {
    // Задние огни: узкое красное свечение за кормой.
    float a = (1.0 - smoothstep(0.35, 1.0, abs(x))) * pow(t, 2.2);
    gl_FragColor = vec4(vec3(1.0, 0.12, 0.08) * a * uAlpha, 1.0);
  }
}`;function V(e,a,c){const s=(u,f)=>{const i=e.createShader(u);if(e.shaderSource(i,f),e.compileShader(i),!e.getShaderParameter(i,e.COMPILE_STATUS))throw new Error(e.getShaderInfoLog(i)??"shader");return i},n=e.createProgram();if(e.attachShader(n,s(e.VERTEX_SHADER,a)),e.attachShader(n,s(e.FRAGMENT_SHADER,c)),e.linkProgram(n),!e.getProgramParameter(n,e.LINK_STATUS))throw new Error(e.getProgramInfoLog(n)??"link");return n}function X(e,a){const c=new Float32Array(16);for(let s=0;s<4;s++)for(let n=0;n<4;n++){let u=0;for(let f=0;f<4;f++)u+=e[f*4+n]*a[s*4+f];c[s*4+n]=u}return c}const bt=(e,a)=>40075016686e-3*Math.cos(e*Math.PI/180)/(512*2**a);function Mt(e,a,c){const s=u=>{const f=Math.max(0,Math.min(1,u));return f*f*(3-2*f)};return(.19+.06*s((e-15.2)/2)+.07*s((e-17.2)/1.8))*Math.min(a,c*1.95)}function gt(e){const a=new Set;for(const c of[-1,0,1])for(const s of[-1,0,1])for(const n of[-1,0,1]){if(!c&&!s&&!n)continue;let u=0,f=-1/0;for(let i=0;i<e.length;i+=3){const h=c*e[i]+s*e[i+1]+n*e[i+2];h>f&&(u=i,f=h)}a.add(u)}return[...a].map(c=>[e[c],e[c+1],e[c+2]])}function Q(e,a,c,s){let n=1/0,u=-1/0,f=1/0,i=-1/0;for(const[h,p,d]of a){const v=e[3]*h+e[7]*p+e[11]*d+e[15];if(v<=0)return null;const r=(e[0]*h+e[4]*p+e[8]*d+e[12])/v,m=(e[1]*h+e[5]*p+e[9]*d+e[13])/v;n=Math.min(n,r),u=Math.max(u,r),f=Math.min(f,m),i=Math.max(i,m)}return{width:(u-n)*c/2,height:(i-f)*s/2}}function J(e,a,c,s){const n=c*Math.PI/180,u=Math.cos(n),f=Math.sin(n);return new Float32Array([u*s,f*s,0,0,f*s,-u*s,0,0,0,0,s,0,e,a,0,1])}function pt(e,a,c){const s=e*Math.PI/180,n=Math.max(a,1)*Math.PI/180,u=-Math.sin(s)*Math.sin(n),f=-Math.cos(s)*Math.sin(n),i=Math.cos(n),h=c*Math.PI/180;return[u*Math.cos(h)-f*Math.sin(h),u*Math.sin(h)+f*Math.cos(h),i]}function Pt(e){const a=parseInt(e.replace("#",""),16);return[(a>>16&255)/255,(a>>8&255)/255,(a&255)/255]}function xt(e,a={}){const c=ft[a.model??"ev"].build(),s=c.positions.length/3,n=gt(c.positions);let u=null,f=null,i=null,h=null,p=null,d=null;const v=new Float32Array(Object.keys(Z).flatMap(m=>Z[Number(m)])),r={id:"car-3d",type:"custom",renderingMode:"3d",failed:!1,renderedBounds:null,onAdd(m,l){u=m;try{const o=l;f=V(o,ht,lt),i=V(o,ut,mt),h=V(o,dt,vt);const t=new Float32Array(s*7);for(let b=0;b<s;b++)t.set(c.positions.subarray(b*3,b*3+3),b*7),t.set(c.normals.subarray(b*3,b*3+3),b*7+3),t[b*7+6]=c.materials[b];p=o.createBuffer(),o.bindBuffer(o.ARRAY_BUFFER,p),o.bufferData(o.ARRAY_BUFFER,t,o.STATIC_DRAW),d=o.createBuffer(),o.bindBuffer(o.ARRAY_BUFFER,d),o.bufferData(o.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,1,1,-1,-1,1,1,-1,1]),o.STATIC_DRAW)}catch(o){r.failed=!0,a.onError?.(o)}},render(m,l){const o=e();if(!o||!u||!f||!i||r.failed)return;const t=m,b=et.fromLngLat([o.lon,o.lat],0),g=u.getZoom(),A=b.meterInMercatorCoordinateUnits()*bt(o.lat,g)/c.length,x=l.defaultProjectionData?.mainMatrix??l.modelViewProjectionMatrix,P=a.gameSize?.(),{clientWidth:L,clientHeight:w}=u.getCanvas(),_=P?Mt(g,L,w):0;let N=A*(P?_*1.9:a.sizePx?.()??60),U=X(x,J(b.x,b.y,o.heading,N));if(r.renderedBounds=null,P&&_>0){for(let R=0;R<4;R++){const E=Q(U,n,L,w),S=E?Math.min(_/E.width,w*.62/E.height):.5;if(Math.abs(1-S)<.002)break;N*=Math.max(.35,Math.min(3,S)),U=X(x,J(b.x,b.y,o.heading,N))}r.renderedBounds=Q(U,n,L,w)}t.clear(t.DEPTH_BUFFER_BIT),t.disable(t.CULL_FACE),t.useProgram(i),t.enable(t.BLEND),t.blendFunc(t.SRC_ALPHA,t.ONE_MINUS_SRC_ALPHA),t.disable(t.DEPTH_TEST),t.uniformMatrix4fv(t.getUniformLocation(i,"uMvp"),!1,U),t.uniform1f(t.getUniformLocation(i,"uAlpha"),.55),t.bindBuffer(t.ARRAY_BUFFER,d);const D=t.getAttribLocation(i,"aUv");t.enableVertexAttribArray(D),t.vertexAttribPointer(D,2,t.FLOAT,!1,8,0),t.drawArrays(t.TRIANGLES,0,6),t.disableVertexAttribArray(D);const W=!!a.night?.()&&!!h;if(W&&h){t.useProgram(h),t.blendFunc(t.ONE,t.ONE),t.uniformMatrix4fv(t.getUniformLocation(h,"uMvp"),!1,U);const R=t.getAttribLocation(h,"aUv");t.enableVertexAttribArray(R),t.vertexAttribPointer(R,2,t.FLOAT,!1,8,0);for(const[E,S,nt]of[[0,[-3.4,2.2,3.4,11.5],.7],[1,[-1.1,-3.6,1.1,-2.25],.5]])t.uniform1f(t.getUniformLocation(h,"uKind"),E),t.uniform4fv(t.getUniformLocation(h,"uRect"),S),t.uniform1f(t.getUniformLocation(h,"uAlpha"),nt),t.drawArrays(t.TRIANGLES,0,6);t.disableVertexAttribArray(R),t.blendFunc(t.SRC_ALPHA,t.ONE_MINUS_SRC_ALPHA)}t.disable(t.BLEND),t.enable(t.DEPTH_TEST),t.depthFunc(t.LEQUAL),t.depthMask(!0),t.useProgram(f),t.uniformMatrix4fv(t.getUniformLocation(f,"uMvp"),!1,U),t.uniform3fv(t.getUniformLocation(f,"uBody"),o.color),t.uniform4fv(t.getUniformLocation(f,"uMats"),v),t.uniform3fv(t.getUniformLocation(f,"uView"),pt(u.getBearing(),u.getPitch(),o.heading)),t.uniform1f(t.getUniformLocation(f,"uNight"),W?1:0),t.bindBuffer(t.ARRAY_BUFFER,p);const k=t.getAttribLocation(f,"aPos"),Y=t.getAttribLocation(f,"aNor"),z=t.getAttribLocation(f,"aMat");for(const[R,E,S]of[[k,3,0],[Y,3,12],[z,1,24]])t.enableVertexAttribArray(R),t.vertexAttribPointer(R,E,t.FLOAT,!1,28,S);t.drawArrays(t.TRIANGLES,0,s);for(const R of[k,Y,z])t.disableVertexAttribArray(R)},onRemove(m,l){const o=l;p&&o.deleteBuffer(p),d&&o.deleteBuffer(d),f&&o.deleteProgram(f),i&&o.deleteProgram(i),h&&o.deleteProgram(h),r.renderedBounds=null,u=null}};return r}export{xt as c,Pt as h};
