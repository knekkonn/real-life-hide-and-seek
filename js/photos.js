const ALLOWED_IMAGE_TYPES=new Set(['image/jpeg','image/pjpeg','image/png','image/webp','image/heic','image/heif','image/heic-sequence','image/heif-sequence']);
const MAX_SOURCE_BYTES=30*1024*1024;
const MAX_UPLOAD_DATA_URL_LENGTH=24000;

async function sniffImageType(file) {
  if(typeof file?.slice!=='function') return null;
  try {
    const bytes=new Uint8Array(await file.slice(0,16).arrayBuffer());
    if(bytes[0]===0xff&&bytes[1]===0xd8&&bytes[2]===0xff) return 'image/jpeg';
    if(bytes.length>=8&&bytes[0]===0x89&&bytes[1]===0x50&&bytes[2]===0x4e&&bytes[3]===0x47) return 'image/png';
    if(bytes.length>=12&&String.fromCharCode(...bytes.slice(0,4))==='RIFF'&&String.fromCharCode(...bytes.slice(8,12))==='WEBP') return 'image/webp';
    if(bytes.length>=12&&String.fromCharCode(...bytes.slice(4,8))==='ftyp') {
      const brands=String.fromCharCode(...bytes.slice(8,12));
      if(['heic','heix','hevc','hevx','heis','hevm','mif1','msf1'].includes(brands)) return 'image/heic';
    }
  } catch { /* The decoder below supplies the user-facing error. */ }
  return null;
}

async function decodeWithImageElement(file) {
  const ImageConstructor=globalThis.Image, URLApi=globalThis.URL;
  if(typeof ImageConstructor!=='function'||typeof URLApi?.createObjectURL!=='function') throw new Error('Bildverarbeitung wird von diesem Browser nicht unterstützt.');
  const sourceUrl=URLApi.createObjectURL(file), image=new ImageConstructor();
  image.decoding='async';
  try {
    await new Promise((resolve,reject)=>{
      image.onload=resolve;
      image.onerror=()=>reject(new Error('Das Bildformat kann der Browser nicht öffnen.'));
      image.src=sourceUrl;
    });
    return {image,close:()=>URLApi.revokeObjectURL(sourceUrl)};
  } catch(error) {
    URLApi.revokeObjectURL(sourceUrl);
    throw error;
  }
}

async function decodePhoto(file,bitmapFactory,imageFactory) {
  let decodeError=null;
  if(typeof bitmapFactory==='function') {
    try {
      const image=await bitmapFactory(file);
      return {image,close:()=>image.close?.()};
    } catch(error) { decodeError=error; }
  }
  try {
    const decoded=await imageFactory(file);
    const image=decoded?.image||decoded;
    if(!image) throw new Error('Das Bild konnte nicht gelesen werden.');
    return {image,close:()=>{if(typeof decoded?.close==='function') decoded.close(); else image.close?.();}};
  } catch {
    throw new Error(decodeError
      ? 'Dein Browser kann dieses Fotoformat nicht öffnen. Wähle ein JPEG oder PNG aus den Foto-Einstellungen.'
      : 'Fotoverarbeitung wird von diesem Browser nicht unterstützt.');
  }
}

export async function compressRoundPhoto(file,{bitmapFactory=globalThis.createImageBitmap,canvasFactory=()=>document.createElement('canvas'),imageFactory=decodeWithImageElement}={}) {
  const mime=String(file?.type||'').toLowerCase();
  const detected=await sniffImageType(file);
  if(!Number.isFinite(file?.size)||file.size>MAX_SOURCE_BYTES||(!ALLOWED_IMAGE_TYPES.has(mime)&&!detected)) throw new Error('Bitte wähle ein Foto unter 30 MB im JPEG-, PNG-, WebP- oder HEIC-Format.');
  if(detected&&!ALLOWED_IMAGE_TYPES.has(detected)) throw new Error('Dieses Bildformat wird nicht unterstützt.');
  const decoded=await decodePhoto(file,bitmapFactory,imageFactory),bitmap=decoded.image;
  try {
    const width=Number(bitmap.width||bitmap.naturalWidth),height=Number(bitmap.height||bitmap.naturalHeight);
    if(!Number.isFinite(width)||!Number.isFinite(height)||width<1||height<1) throw new Error('Das Foto konnte nicht gelesen werden.');
    if(width*height>50_000_000) throw new Error('Das Foto hat eine zu hohe Auflösung. Bitte ein kleineres Foto wählen.');
    // The Worker accepts photos up to 320×240 pixels. Keep the first encode
    // inside those limits too; a flat scene can fit the byte cap at larger sizes.
    const serverScale=Math.min(1,320/width,240/height);
    for(let reduction=1;reduction>=.15;reduction*=.78) {
      const scale=serverScale*reduction;
      const canvas=canvasFactory(); canvas.width=Math.max(1,Math.round(width*scale)); canvas.height=Math.max(1,Math.round(height*scale));
      const context=canvas.getContext('2d',{alpha:false});
      if(!context) throw new Error('Foto kann auf diesem Gerät nicht verarbeitet werden.');
      context.drawImage(bitmap,0,0,canvas.width,canvas.height);
      for(const quality of [.72,.62,.52,.42,.32,.24,.18]) {
        const data=canvas.toDataURL('image/jpeg',quality);
        if(data.startsWith('data:image/jpeg;base64,')&&data.length<=MAX_UPLOAD_DATA_URL_LENGTH) return data;
      }
    }
    throw new Error('Foto konnte nicht klein genug komprimiert werden. Bitte näher heranzoomen und erneut aufnehmen.');
  } finally { decoded.close(); }
}
