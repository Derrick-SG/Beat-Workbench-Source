import path from 'node:path';
import {realpath} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const project=path.resolve(fileURLToPath(new URL('../../',import.meta.url)));
const within=(p,root)=>p===root||p.startsWith(root+path.sep);
export async function validatePrivateDirectory(dir){
 const resolved=path.resolve(dir),parts=[];let cursor=resolved;
 for(;;){try{cursor=await realpath(cursor);break;}catch(e){if(e.code!=='ENOENT')throw e;const parent=path.dirname(cursor);if(parent===cursor)throw e;parts.unshift(path.basename(cursor));cursor=parent;}}
 const effective=path.resolve(cursor,...parts),norm=p=>path.resolve(p).toLowerCase();
 const roots=[project,process.env.OneDrive,process.env.OneDriveConsumer,process.env.OneDriveCommercial].filter(Boolean);
 for(const candidate of [resolved,effective]){if(/(?:^|[\\/])(?:baidusyncdisk|onedrive(?:[^\\/]*))(?:[\\/]|$)/i.test(candidate)||roots.some(root=>within(norm(candidate),norm(root))))throw Error('私有配置必须位于工程、百度同步及OneDrive目录之外');}
 return effective;
}
