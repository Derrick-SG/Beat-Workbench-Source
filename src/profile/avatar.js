import { validateAvatarShape } from '../model/workspace.js';

export async function prepareAvatar(file) {
  if (file.size>5*1024*1024) throw Error('图片超过5 MB，请选择较小的图片。');
  const bytes=new Uint8Array(await file.arrayBuffer());
  const png=bytes[0]===137 && bytes[1]===80 && bytes[2]===78 && bytes[3]===71;
  const jpg=bytes[0]===255 && bytes[1]===216 && bytes[2]===255;
  const webp=String.fromCharCode(...bytes.slice(0,4))==='RIFF' && String.fromCharCode(...bytes.slice(8,12))==='WEBP';
  if ((!png&&!jpg&&!webp) || !['image/png','image/jpeg','image/webp'].includes(file.type)) throw Error('请选择有效的 JPEG、PNG 或 WebP 图片。');
  const url=URL.createObjectURL(file);
  try {
    const image=new Image(); image.src=url;
    try {await image.decode();} catch {throw Error('无法读取此图片，请换一张图片。');}
    if (image.naturalWidth*image.naturalHeight>16000000) throw Error('图片分辨率过高，请选择不超过1600万像素的图片。');
    const canvas=document.createElement('canvas'); canvas.width=canvas.height=256;
    const ctx=canvas.getContext('2d'); ctx.fillStyle='#edf0f4'; ctx.fillRect(0,0,256,256);
    const side=Math.min(image.naturalWidth,image.naturalHeight);
    ctx.drawImage(image,(image.naturalWidth-side)/2,(image.naturalHeight-side)/2,side,side,0,0,256,256);
    for (const quality of [.9,.75,.55]) {
      const dataUrl=canvas.toDataURL('image/jpeg',quality);
      if (atob(dataUrl.split(',')[1]).length<=200*1024) return {mime:'image/jpeg',dataUrl};
    }
    throw Error('无法生成合适大小的头像，请换一张图片。');
  } finally {URL.revokeObjectURL(url);}
}
export async function validateAvatar(avatar) {
  validateAvatarShape(avatar); if (!avatar) return null;
  const bytes=Uint8Array.from(atob(avatar.dataUrl.split(',')[1]),x=>x.charCodeAt(0));
  const blob=new Blob([bytes],{type:avatar.mime});
  await prepareAvatar(blob);
  const image=new Image(),url=URL.createObjectURL(blob);
  try{image.src=url;await image.decode();if(image.naturalWidth!==256||image.naturalHeight!==256)throw Error('备份头像必须为256×256缩略图');}finally{URL.revokeObjectURL(url);}
  return structuredClone(avatar);
}
