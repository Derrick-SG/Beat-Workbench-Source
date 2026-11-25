import {createPublicKey,verify} from 'node:crypto';

const jwksUrl='https://auth.openai.com/.well-known/jwks.json';
function decode(part){return JSON.parse(Buffer.from(part,'base64url').toString('utf8'));}
export async function verifyIdToken(token,clientId,nonce,fetchImpl=fetch){
  if(typeof token!=='string'||token.length>16384)throw Error('ID token 无效');
  const parts=token.split('.');if(parts.length!==3)throw Error('ID token 无效');
  let header,payload;try{header=decode(parts[0]);payload=decode(parts[1]);}catch{throw Error('ID token 无效');}
  if(header.alg!=='RS256'||typeof header.kid!=='string'||!header.kid)throw Error('ID token 签名算法无效');
  const response=await fetchImpl(jwksUrl,{signal:AbortSignal.timeout(10000)});if(!response.ok)throw Error('无法核验 OpenAI 身份密钥');
  const jwks=await response.json();const key=jwks.keys?.find(k=>k.kid===header.kid&&k.kty==='RSA'&&(!k.use||k.use==='sig')&&(!k.alg||k.alg==='RS256'));
  if(!key)throw Error('ID token 签名密钥无效');
  const verified=verify('RSA-SHA256',Buffer.from(parts[0]+'.'+parts[1]),createPublicKey({key,format:'jwk'}),Buffer.from(parts[2],'base64url'));
  if(!verified)throw Error('ID token 签名无效');
  const now=Math.floor(Date.now()/1000);
  if(payload.iss!=='https://auth.openai.com')throw Error('ID token issuer 无效');
  if(!(payload.aud===clientId||Array.isArray(payload.aud)&&payload.aud.includes(clientId)))throw Error('ID token audience 无效');
  if(typeof payload.exp!=='number'||payload.exp<now-5||typeof payload.iat!=='number'||payload.iat>now+5)throw Error('ID token 已过期或时间无效');
  if(payload.nonce!==nonce)throw Error('ID token nonce 不匹配');
  if(typeof payload.sub!=='string'||!payload.sub)throw Error('ID token subject 无效');
  return {sub:payload.sub,email:typeof payload.email==='string'&&payload.email_verified===true?payload.email:null};
}
