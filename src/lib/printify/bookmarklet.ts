// ---------------------------------------------------------------------------
// The bookmarklet that applies a Mockup Studio payload inside Printify.
//
// It runs ONLY on printify.com. It reads the payload the Studio copied, reads
// the user's own Printify web session from that origin's localStorage, and
// calls Printify's own BFF with the user's cookies first. The access token is
// used only as a same-origin 401 fallback and is never sent anywhere else.
//
// The app cannot do this step itself: selecting mockups is not a public API.
// ---------------------------------------------------------------------------

export const MOCKUP_BRIDGE_BOOKMARKLET = `javascript:(async()=>{
try{
 const host=location.hostname;
 /* Exactly printify.com: the app and its BFF live there, and localStorage is
    origin-scoped, so a www/subdomain tab has neither the session nor the API. */
 if(host!=='printify.com'){alert('Run this bookmarklet on printify.com (not www.printify.com). It needs your Printify session.');return}
 let raw='';
 try{raw=await navigator.clipboard.readText()}catch(e){}
 if(!raw.trim()){raw=window.prompt('Paste the Mockup Studio payload (Ctrl+V):','')||''}
 if(!raw.trim())return;
 let payload;
 try{payload=JSON.parse(raw)}catch(e){alert('The clipboard does not contain a Mockup Studio payload.');return}
 if(!payload||payload.source!=='mockup-studio'||payload.version!==1||!Array.isArray(payload.products)||payload.products.length===0){alert('That is not a Mockup Studio payload. Copy it again from Listing images.');return}
 let session=null;
 try{const stored=localStorage.getItem('session')||sessionStorage.getItem('session');if(stored)session=JSON.parse(stored)}catch(e){}
 const userId=session&&(session.user_id||session.userId||session.id);
 if(!userId){alert('Sign in to Printify in this tab first. The bookmarklet needs your own session.');return}
 const token=session&&(session.access_token||session.accessToken);
 let csrf='';
 try{const m=document.cookie.match(/(?:^|;\\s*)XSRF-TOKEN=([^;]+)/);if(m)csrf=decodeURIComponent(m[1])}catch(e){}
 const headers={'Content-Type':'application/json','Accept':'application/json','X-Requested-With':'XMLHttpRequest'};
 if(csrf)headers['X-XSRF-TOKEN']=csrf;
 const total=payload.products.reduce((sum,p)=>sum+((p.uploads&&p.uploads.length)||0),0);
 const list=payload.products.map(p=>'• '+p.productTitle+' ('+p.productId+') — '+((p.uploads&&p.uploads.length)||0)+' image'+(((p.uploads&&p.uploads.length)||0)===1?'':'s')).join('\\n');
 if(!window.confirm('Apply '+total+' mockup image'+(total===1?'':'s')+' to '+payload.products.length+' Printify product'+(payload.products.length===1?'':'s')+'?\\n\\n'+list+'\\n\\nExisting selections are kept and the new images become the main images.'))return;
 const sleep=ms=>new Promise(r=>setTimeout(r,ms));
 const call=async(url,opts)=>{
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),30000);
  try{
   let res=await fetch(url,Object.assign({credentials:'include'},opts,{signal:controller.signal}));
   if(res.status===401&&token){
    const auth=Object.assign({},opts.headers,{Authorization:'Bearer '+token});
    res=await fetch(url,Object.assign({credentials:'include'},opts,{headers:auth,signal:controller.signal}));
   }
   return res;
  }finally{clearTimeout(timer)}
 };
 const apply=async(p)=>{
  if(!p||typeof p.productId!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(p.productId)||typeof p.shopId!=='number'||!Number.isFinite(p.shopId)||p.shopId<=0||!Array.isArray(p.uploads))return {id:(p&&p.productId)||'?',ok:false,error:'Invalid product entry.'};
  const uploads=p.uploads.filter(u=>u&&typeof u.mockupId==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(u.mockupId)&&typeof u.src==='string'&&u.src.startsWith('https://'));
  if(uploads.length!==p.uploads.length||uploads.length===0)return {id:p.productId,ok:false,error:'Invalid image entry in the payload.'};
  const base='/api/v1/users/'+encodeURIComponent(userId)+'/shops/'+encodeURIComponent(p.shopId)+'/products/'+encodeURIComponent(p.productId);
  let layout=null;
  try{
   const res=await call(base+'/mockup-library-layout',{method:'GET',headers});
   if(res.ok){
    const data=await res.json();
    /* A malformed 200 must not count as a readable layout: treating {} as
       "empty" would replace the product's real selection without asking. */
    if(data&&Array.isArray(data.groups)&&data.selected_mockups)layout=data;
   }
  }catch(e){}
  if(!layout){
   if(!window.confirm('Could not read the existing mockups for "'+(p.productTitle||p.productId)+'".\\n\\nContinue will REPLACE its current selected mockups with these '+uploads.length+' images.')){return {id:p.productId,ok:false,error:'Skipped: existing selection could not be read.'}}
  }
  let rawSelected=[];
  if(layout&&layout.selected_mockups){
   if(Array.isArray(layout.selected_mockups))rawSelected=layout.selected_mockups.map(e=>typeof e==='string'?{id:e}:e);
   else rawSelected=Object.entries(layout.selected_mockups).map(([id,v])=>Object.assign({},(v&&typeof v==='object')?v:{},{id:id}));
  }
  const existingSelected=rawSelected.filter(e=>e&&typeof e.id==='string'&&e.id);
  const existingGroups=layout&&Array.isArray(layout.groups)?layout.groups:[];
  const newIds=[...new Set(uploads.map(u=>u.mockupId))];
  const newSet=new Set(newIds);
  const newEntries=[];
  const seenNew=new Set();
  for(const u of uploads){
   if(seenNew.has(u.mockupId))continue;
   seenNew.add(u.mockupId);
   newEntries.push({id:u.mockupId,src:u.src,type:'UPLOADED',ownership:'MPL'});
  }
  const selected=[...newEntries];
  const seen=new Set(newIds);
  for(const e of existingSelected){
   if(seen.has(e.id))continue;
   seen.add(e.id);
   const clean={id:e.id};
   if(typeof e.src==='string')clean.src=e.src;
   if(typeof e.type==='string')clean.type=e.type;
   if(typeof e.ownership==='string')clean.ownership=e.ownership;
   selected.push(clean);
  }
  const cleanGroup=g=>({
   group_key:typeof g.group_key==='string'?g.group_key:'',
   label:typeof g.label==='string'?g.label:(typeof g.group_key==='string'?g.group_key:''),
   variant_ids:Array.isArray(g.variant_ids)?g.variant_ids:[],
   mockup_ids:Array.isArray(g.mockup_ids)?[...new Set(g.mockup_ids.filter(id=>typeof id==='string'&&id))]:[]
  });
  const existingClean=existingGroups.filter(g=>g&&typeof g==='object').map(cleanGroup).filter(g=>g.group_key);
  const existingNot=existingClean.find(g=>g.group_key==='not_linked');
  const mergedIds=[...newIds,...(existingNot?existingNot.mockup_ids:[]).filter(id=>!newSet.has(id))];
  const notLinked={group_key:'not_linked',label:'not_linked',variant_ids:existingNot?existingNot.variant_ids:[],mockup_ids:[...new Set(mergedIds)]};
  const groups=[notLinked,...existingClean.filter(g=>g.group_key!=='not_linked')];
  const url=base+'/selected-mockups';
  for(let attempt=0;attempt<4;attempt++){
   const res=await call(url,{method:'PUT',headers,body:JSON.stringify({groups,selected_mockups:selected})});
   if(res.status===429){await sleep(1500*(attempt+1));continue}
   if(res.ok)return {id:p.productId,ok:true};
   let text='';
   try{text=await res.text()}catch(e){}
   if(res.status===401||res.status===403)return {id:p.productId,ok:false,error:'Printify rejected the session. Sign in again in this tab.'};
   return {id:p.productId,ok:false,error:'HTTP '+res.status+(text?' — '+text.slice(0,180):'')};
  }
  return {id:p.productId,ok:false,error:'Printify kept rate-limiting (429). Try again in a minute.'};
 };
 const results=[];let index=0;
 const workers=Array.from({length:Math.min(2,payload.products.length)},async()=>{
  for(;;){
   const i=index++;
   if(i>=payload.products.length)break;
   try{results[i]=await apply(payload.products[i])}catch(e){results[i]={id:payload.products[i].productId,ok:false,error:String(e&&e.message||e)}}
  }
 });
 await Promise.all(workers);
 const ok=results.filter(r=>r&&r.ok).length;
 const bad=results.filter(r=>r&&!r.ok);
 alert('Mockup Studio: applied '+ok+' of '+payload.products.length+' product'+(payload.products.length===1?'':'s')+'.'+(bad.length?'\\n\\nFailed:\\n'+bad.map(r=>r.id+': '+r.error).join('\\n'):'\\n\\nYou can check the mockups in Printify now.'));
}catch(e){alert('Mockup Studio bridge failed: '+(e&&e.message?e.message:String(e)));}
})()`;
