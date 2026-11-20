import{i as Z}from"./maplibre-gl-B8lVyYEz.js";const G=4.62,y=G/2,z=1.94,X=.3,I=.37,q=.27,O=[1.42,-1.4],V=(i,s,c)=>Math.min(c,Math.max(s,i)),U=(i,s,c)=>{const a=V((c-i)/(s-i),0,1);return a*a*(3-2*a)},T=(i,s)=>Math.sign(i)*Math.abs(i)**(2/s);function B(i){const s=i/y,c=s>0?4.2:6;return z/2*(1-Math.abs(s)**c)**(1/c)}function E(i){const s=.78+.22*U(2.3,1.15,i),c=1.02-.08*U(-2.05,-2.31,i);return i>0?Math.min(s,1+.02*(1-i/y)):c}function S(i){return X+.08*U(1.9,2.31,i)+.12*U(-1.95,-2.31,i)}function Q(i,s){let c=0;for(const a of O){const n=Math.hypot(i-a,s-I);c=Math.max(c,1-U(I+.05,I+.13,n))}return c}function J(i,s){let c=0;for(const a of O)c=Math.max(c,Math.exp(-(((i-a)/.55)**2)));return .035*c*Math.exp(-(((s-.72)/.22)**2))}function k(i,s,c,a,n){const f=s.length,l=s[0].length,r=(v,e)=>s[V(v,0,f-1)][c?(e+l)%l:V(e,0,l-1)],h=(v,e)=>{const u=r(v+1,e),o=r(v-1,e),t=r(v,e+1),m=r(v,e-1),p=[u[0]-o[0],u[1]-o[1],u[2]-o[2]],M=[t[0]-m[0],t[1]-m[1],t[2]-m[2]];let A=[p[1]*M[2]-p[2]*M[1],p[2]*M[0]-p[0]*M[2],p[0]*M[1]-p[1]*M[0]];const L=r(v,e),P=n(v);A[0]*(L[0]-P[0])+A[1]*(L[1]-P[1])+A[2]*(L[2]-P[2])<0&&(A=[-A[0],-A[1],-A[2]]);const x=Math.hypot(...A)||1;return[A[0]/x,A[1]/x,A[2]/x]},g=s.map((v,e)=>v.map((u,o)=>h(e,o))),b=c?l:l-1;for(let v=0;v<f-1;v++)for(let e=0;e<b;e++){const u=(e+1)%l,o=[s[v][e],s[v+1][e],s[v+1][u],s[v][u]],t=[g[v][e],g[v+1][e],g[v+1][u],g[v][u]],m=[(o[0][0]+o[2][0])/2,(o[0][1]+o[2][1])/2,(o[0][2]+o[2][2])/2],p=[(t[0][0]+t[2][0])/2,(t[0][1]+t[2][1])/2,(t[0][2]+t[2][2])/2],M=a(m,p);i.triN(o[0],o[1],o[2],t[0],t[1],t[2],M),i.triN(o[0],o[2],o[3],t[0],t[2],t[3],M)}}function W(i,s,c,a=2.2){const n=[];for(let f=0;f<=c;f++){const l=f/c,r=.5-.5*Math.cos(Math.PI*l);n.push(i+(s-i)*(l+(r-l)*(a-1)*.5))}return n}function $(){const i=new j,s=30,c=W(-y+.004,y-.004,34),a=c.map(e=>{const u=B(e),o=S(e),t=E(e),m=e/y,p=m>0?7:12,M=(1-Math.abs(m)**p)**(1/p),A=(o+t)/2,L=(t-o)/2*(.35+.65*M),P=[];for(let x=0;x<s;x++){const F=x/s*Math.PI*2,_=A+L*T(Math.sin(F),4.2);let R=u*T(Math.cos(F),3.4);R*=1+J(e,_);const w=Q(e,_);w>0&&Math.abs(R)>.3&&(R=Math.sign(R)*(Math.abs(R)-.17*w)),P.push([R,e,_])}return P});k(i,a,!0,(e,u)=>{const[,o,t]=e;return t<S(o)+.05||u[2]<-.5&&t<.6?d.trim:d.body},e=>[0,c[e],(S(c[e])+E(c[e]))/2]);for(const e of[0,a.length-1]){const u=a[e],o=[0,u[0][1],(S(u[0][1])+E(u[0][1]))/2],t=[0,e===0?-1:1,0];for(let m=0;m<u.length;m++){const p=Math.min(u[m][2],u[(m+1)%u.length][2])<S(u[0][1])+.1;i.triN(o,u[m],u[(m+1)%u.length],t,t,t,p?d.trim:d.body)}}const n=-2.02,f=1.18,l=W(n,f,22,1.6),r=e=>1.6-.04*((e+.4)/1.6)**2,h=e=>{const u=U(f,.05,e),o=.25+.75*U(n,-1.25,e);return Math.max(.004,(r(e)-E(e))*u*o)},g=16,b=l.map(e=>{const u=E(e)-.005,o=h(e),t=B(e)*.93,m=[];for(let p=0;p<=g;p++){const M=p/g*Math.PI,A=T(Math.cos(M),3.2),L=Math.abs(T(Math.sin(M),3.2)),P=1-.17*L;m.push([t*P*A,e,u+o*L])}return m});k(i,b,!1,(e,u)=>{const[o,t,m]=e,p=(t-n)/(f-n),M=B(t)*.93*.83;return u[2]>.82&&Math.abs(o)>M*.82&&p>.12&&p<.82?d.body:u[2]>.82&&p>.12&&p<.84?d.roof:t>-.12&&t<.02&&Math.abs(u[0])>.6&&m<1.5?d.trim:d.glass},e=>[0,l[e],E(l[e])]);const v=(e,u)=>{let o=0;for(let t=a.length-1;t>0;t--){const m=a[t];if(m.some(M=>Math.abs(M[2]-u)<.06&&Math.abs(M[0])>=Math.abs(e))){o=m[0][1];break}}return o};for(const e of[-1,1]){const u=[];for(let o=0;o<=6;o++){const t=e*(.12+.7*o/6);u.push([t,v(t,.73)+.012,.73])}for(let o=0;o<u.length-1;o++){const t=u[o],m=u[o+1],p=[0,1,0];i.triN([t[0],t[1],t[2]-.016],[m[0],m[1],m[2]-.016],[m[0],m[1],m[2]+.016],p,p,p,d.headlight),i.triN([t[0],t[1],t[2]-.016],[m[0],m[1],m[2]+.016],[t[0],t[1],t[2]+.016],p,p,p,d.headlight)}}for(const e of O)for(const u of[-1,1]){const o=B(e);i.wheelEv(u*(o-.1-q/2),e,I,I,q)}return i.build(G,z+.07,r(0))}const d={body:0,glass:1,tire:2,rim:3,headlight:4,taillight:5,trim:6,roof:7},Y={[d.body]:[1,1,1,0],[d.glass]:[.09,.12,.16,0],[d.tire]:[.07,.07,.08,0],[d.rim]:[.62,.65,.69,0],[d.headlight]:[1,.97,.86,1],[d.taillight]:[.95,.13,.12,1],[d.trim]:[.12,.13,.15,0],[d.roof]:[.05,.06,.08,0]};class j{pos=[];nor=[];mat=[];tri(s,c,a,n){const f=[c[0]-s[0],c[1]-s[1],c[2]-s[2]],l=[a[0]-s[0],a[1]-s[1],a[2]-s[2]];let r=[f[1]*l[2]-f[2]*l[1],f[2]*l[0]-f[0]*l[2],f[0]*l[1]-f[1]*l[0]];const h=Math.hypot(...r)||1;r=[r[0]/h,r[1]/h,r[2]/h];for(const g of[s,c,a])this.pos.push(...g),this.nor.push(...r),this.mat.push(n)}triN(s,c,a,n,f,l,r){for(const[h,g]of[[s,n],[c,f],[a,l]])this.pos.push(...h),this.nor.push(...g),this.mat.push(r)}wheelEv(s,c,a,n,f,l=30){const r=s>0?1:-1,h=s+r*f/2,g=s-r*f/2,b=(u,o,t)=>[u,c+Math.cos(o)*t,a+Math.sin(o)*t],v=(u,o=0,t=1)=>{const m=Math.hypot(o,t)||1;return[o/m,Math.cos(u)*t/m,Math.sin(u)*t/m]},e=[r,0,0];for(let u=0;u<l;u++){const o=u/l*Math.PI*2,t=(u+1)/l*Math.PI*2,m=h-r*.05;this.triN(b(g,o,n),b(g,t,n),b(m,t,n),v(o),v(t),v(t),d.tire),this.triN(b(g,o,n),b(m,t,n),b(m,o,n),v(o),v(t),v(o),d.tire),this.triN(b(m,o,n),b(m,t,n),b(h,t,n*.9),v(o,r*.7),v(t,r*.7),v(t,r*1.4),d.tire),this.triN(b(m,o,n),b(h,t,n*.9),b(h,o,n*.9),v(o,r*.7),v(t,r*1.4),v(o,r*1.4),d.tire),this.triN(b(h,o,n*.9),b(h,t,n*.9),b(h,t,n*.7),e,e,e,d.tire),this.triN(b(h,o,n*.9),b(h,t,n*.7),b(h,o,n*.7),e,e,e,d.tire);const p=u*5/l%1<.4,M=h-r*.012;this.triN(b(M,o,n*.7),b(M,t,n*.7),b(M,t,n*.6),e,e,e,d.rim),this.triN(b(M,o,n*.7),b(M,t,n*.6),b(M,o,n*.6),e,e,e,d.rim);const A=p?d.rim:d.trim;this.triN(b(M,o,n*.6),b(M,t,n*.6),b(M,t,n*.22),e,e,e,A),this.triN(b(M,o,n*.6),b(M,t,n*.22),b(M,o,n*.22),e,e,e,A),this.triN(b(M,o,n*.22),b(M,t,n*.22),[M+r*.01,c,a],e,e,e,d.rim)}}quad(s,c,a,n,f){this.tri(s,c,a,f),this.tri(s,a,n,f)}box(s,c,a,n,f,l,r){const h=(g,b,v)=>[g,b,v];this.quad(h(s,a,l),h(c,a,l),h(c,n,l),h(s,n,l),r),this.quad(h(s,n,f),h(c,n,f),h(c,a,f),h(s,a,f),r),this.quad(h(s,n,f),h(s,n,l),h(c,n,l),h(c,n,f),r),this.quad(h(c,a,f),h(c,a,l),h(s,a,l),h(s,a,f),r),this.quad(h(c,n,f),h(c,n,l),h(c,a,l),h(c,a,f),r),this.quad(h(s,a,f),h(s,a,l),h(s,n,l),h(s,n,f),r)}extrude(s,c,a){const n=c/2,f=s.map(([r,h])=>[-n,r,h]),l=s.map(([r,h])=>[n,r,h]);for(let r=1;r<s.length-1;r++)this.tri(l[0],l[r],l[r+1],a),this.tri(f[0],f[r+1],f[r],a);for(let r=0;r<s.length;r++){const h=(r+1)%s.length;this.quad(f[r],f[h],l[h],l[r],a)}}wheel(s,c,a,n,f,l=12){const r=s-f/2,h=s+f/2,g=s>0?h:r;for(let b=0;b<l;b++){const v=b/l*Math.PI*2,e=(b+1)/l*Math.PI*2,u=(o,t,m=n)=>[o,c+Math.cos(t)*m,a+Math.sin(t)*m];this.quad(u(r,v),u(r,e),u(h,e),u(h,v),d.tire),g===h?this.tri([h,c,a],u(h,v,n*.62),u(h,e,n*.62),d.rim):this.tri([r,c,a],u(r,e,n*.62),u(r,v,n*.62),d.rim)}}build(s,c,a){return{positions:new Float32Array(this.pos),normals:new Float32Array(this.nor),materials:new Float32Array(this.mat),length:s,width:c,height:a}}}function tt(){const i=new j,s=1.9;i.extrude([[-2.25,.36],[2.25,.36],[2.3,.62],[2.22,.86],[1.25,1.06],[-2.12,1.08],[-2.26,.95]],s,d.body),i.extrude([[-2.02,1.06],[1.2,1.06],[.42,1.6],[-1.86,1.62]],1.72,d.glass),i.box(-.82,.82,-1.86,.4,1.6,1.67,d.body),i.box(-.8,-.72,-1.7,.2,1.67,1.71,d.trim),i.box(.72,.8,-1.7,.2,1.67,1.71,d.trim);for(const a of[-1,1])i.box(a*.87-.02,a*.87+.02,-.55,-.42,1.06,1.6,d.body),i.box(a*.86-.02,a*.86+.02,-1.95,-1.7,1.06,1.6,d.body);i.box(-.93,.93,2.02,2.32,.34,.5,d.trim),i.box(-.93,.93,-2.3,-2,.34,.52,d.trim),i.box(-.97,-.93,-1.2,1.2,.34,.46,d.trim),i.box(.93,.97,-1.2,1.2,.34,.46,d.trim);const c=(a,n,f)=>{f(a,n),f(-n,-a)};c(.6,.86,(a,n)=>i.box(a,n,2.24,2.31,.72,.8,d.headlight)),c(.6,.88,(a,n)=>i.box(a,n,-2.28,-2.22,.82,.93,d.taillight)),i.box(-.6,.6,-2.27,-2.23,.86,.89,d.taillight);for(const a of[1.42,-1.38])for(const n of[-1,1])i.wheel(n*.83,a,.36,.36,.26);return i.build(4.6,s,1.71)}const ot={ev:{name:"Электрокроссовер",build:()=>$()},suv:{name:"Кроссовер (простой)",build:tt}},nt=`
attribute vec3 aPos; attribute vec3 aNor; attribute float aMat;
uniform mat4 uMvp;
varying vec3 vNor; varying float vMat; varying vec3 vPos;
void main(){ vNor = aNor; vMat = aMat; vPos = aPos; gl_Position = uMvp * vec4(aPos, 1.0); }`,et=`
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
}`,st=`
attribute vec2 aUv; uniform mat4 uMvp; varying vec2 vUv;
void main(){ vUv = aUv; gl_Position = uMvp * vec4(aUv.x * 1.35, aUv.y * 2.75, 0.02, 1.0); }`,at=`
precision mediump float; varying vec2 vUv; uniform float uAlpha;
void main(){
  vec2 q = abs(vUv);
  float box = length(max(q - vec2(0.55, 0.7), 0.0)) + min(max(q.x - 0.55, q.y - 0.7), 0.0);
  float soft = 1.0 - smoothstep(-0.35, 0.6, box);
  float contact = 1.0 - smoothstep(-0.32, 0.02, box);
  gl_FragColor = vec4(0.0, 0.0, 0.0, uAlpha * (0.55 * soft + 0.45 * contact));
}`,rt=`
attribute vec2 aUv; uniform mat4 uMvp; uniform vec4 uRect; varying vec2 vUv;
void main(){ vUv = aUv * 0.5 + 0.5; vec2 p = mix(uRect.xy, uRect.zw, vUv); gl_Position = uMvp * vec4(p, 0.03, 1.0); }`,it=`
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
}`;function D(i,s,c){const a=(f,l)=>{const r=i.createShader(f);if(i.shaderSource(r,l),i.compileShader(r),!i.getShaderParameter(r,i.COMPILE_STATUS))throw new Error(i.getShaderInfoLog(r)??"shader");return r},n=i.createProgram();if(i.attachShader(n,a(i.VERTEX_SHADER,s)),i.attachShader(n,a(i.FRAGMENT_SHADER,c)),i.linkProgram(n),!i.getProgramParameter(n,i.LINK_STATUS))throw new Error(i.getProgramInfoLog(n)??"link");return n}function ct(i,s){const c=new Float32Array(16);for(let a=0;a<4;a++)for(let n=0;n<4;n++){let f=0;for(let l=0;l<4;l++)f+=i[l*4+n]*s[a*4+l];c[a*4+n]=f}return c}const ft=(i,s)=>40075016686e-3*Math.cos(i*Math.PI/180)/(512*2**s);function lt(i,s,c,a){const n=c*Math.PI/180,f=Math.cos(n),l=Math.sin(n);return new Float32Array([f*a,l*a,0,0,l*a,-f*a,0,0,0,0,a,0,i,s,0,1])}function ht(i,s,c){const a=i*Math.PI/180,n=Math.max(s,1)*Math.PI/180,f=-Math.sin(a)*Math.sin(n),l=-Math.cos(a)*Math.sin(n),r=Math.cos(n),h=c*Math.PI/180;return[f*Math.cos(h)-l*Math.sin(h),f*Math.sin(h)+l*Math.cos(h),r]}function mt(i){const s=parseInt(i.replace("#",""),16);return[(s>>16&255)/255,(s>>8&255)/255,(s&255)/255]}function vt(i,s={}){const c=ot[s.model??"ev"].build(),a=c.positions.length/3;let n=null,f=null,l=null,r=null,h=null,g=null;const b=new Float32Array(Object.keys(Y).flatMap(e=>Y[Number(e)])),v={id:"car-3d",type:"custom",renderingMode:"3d",failed:!1,onAdd(e,u){n=e;try{const o=u;f=D(o,nt,et),l=D(o,st,at),r=D(o,rt,it);const t=new Float32Array(a*7);for(let m=0;m<a;m++)t.set(c.positions.subarray(m*3,m*3+3),m*7),t.set(c.normals.subarray(m*3,m*3+3),m*7+3),t[m*7+6]=c.materials[m];h=o.createBuffer(),o.bindBuffer(o.ARRAY_BUFFER,h),o.bufferData(o.ARRAY_BUFFER,t,o.STATIC_DRAW),g=o.createBuffer(),o.bindBuffer(o.ARRAY_BUFFER,g),o.bufferData(o.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,1,1,-1,-1,1,1,-1,1]),o.STATIC_DRAW)}catch(o){v.failed=!0,s.onError?.(o)}},render(e,u){const o=i();if(!o||!n||!f||!l||v.failed)return;const t=e,m=Z.fromLngLat([o.lon,o.lat],0),M=(s.sizePx?.()??60)*ft(o.lat,n.getZoom())/c.length,A=m.meterInMercatorCoordinateUnits()*M,L=u.defaultProjectionData?.mainMatrix??u.modelViewProjectionMatrix,P=ct(L,lt(m.x,m.y,o.heading,A));t.clear(t.DEPTH_BUFFER_BIT),t.disable(t.CULL_FACE),t.useProgram(l),t.enable(t.BLEND),t.blendFunc(t.SRC_ALPHA,t.ONE_MINUS_SRC_ALPHA),t.disable(t.DEPTH_TEST),t.uniformMatrix4fv(t.getUniformLocation(l,"uMvp"),!1,P),t.uniform1f(t.getUniformLocation(l,"uAlpha"),.55),t.bindBuffer(t.ARRAY_BUFFER,g);const x=t.getAttribLocation(l,"aUv");t.enableVertexAttribArray(x),t.vertexAttribPointer(x,2,t.FLOAT,!1,8,0),t.drawArrays(t.TRIANGLES,0,6),t.disableVertexAttribArray(x);const F=!!s.night?.()&&!!r;if(F&&r){t.useProgram(r),t.blendFunc(t.ONE,t.ONE),t.uniformMatrix4fv(t.getUniformLocation(r,"uMvp"),!1,P);const N=t.getAttribLocation(r,"aUv");t.enableVertexAttribArray(N),t.vertexAttribPointer(N,2,t.FLOAT,!1,8,0);for(const[C,H,K]of[[0,[-3.4,2.2,3.4,11.5],.7],[1,[-1.1,-3.6,1.1,-2.25],.5]])t.uniform1f(t.getUniformLocation(r,"uKind"),C),t.uniform4fv(t.getUniformLocation(r,"uRect"),H),t.uniform1f(t.getUniformLocation(r,"uAlpha"),K),t.drawArrays(t.TRIANGLES,0,6);t.disableVertexAttribArray(N),t.blendFunc(t.SRC_ALPHA,t.ONE_MINUS_SRC_ALPHA)}t.disable(t.BLEND),t.enable(t.DEPTH_TEST),t.depthFunc(t.LEQUAL),t.depthMask(!0),t.useProgram(f),t.uniformMatrix4fv(t.getUniformLocation(f,"uMvp"),!1,P),t.uniform3fv(t.getUniformLocation(f,"uBody"),o.color),t.uniform4fv(t.getUniformLocation(f,"uMats"),b),t.uniform3fv(t.getUniformLocation(f,"uView"),ht(n.getBearing(),n.getPitch(),o.heading)),t.uniform1f(t.getUniformLocation(f,"uNight"),F?1:0),t.bindBuffer(t.ARRAY_BUFFER,h);const _=t.getAttribLocation(f,"aPos"),R=t.getAttribLocation(f,"aNor"),w=t.getAttribLocation(f,"aMat");for(const[N,C,H]of[[_,3,0],[R,3,12],[w,1,24]])t.enableVertexAttribArray(N),t.vertexAttribPointer(N,C,t.FLOAT,!1,28,H);t.drawArrays(t.TRIANGLES,0,a);for(const N of[_,R,w])t.disableVertexAttribArray(N)},onRemove(e,u){const o=u;h&&o.deleteBuffer(h),g&&o.deleteBuffer(g),f&&o.deleteProgram(f),l&&o.deleteProgram(l),r&&o.deleteProgram(r),n=null}};return v}export{vt as c,mt as h};
