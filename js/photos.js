const ALLOWED_IMAGE_TYPES=new Set(['image/jpeg','image/png','image/webp']);
const MAX_SOURCE_BYTES=20*1024*1024;
const MAX_UPLOAD_DATA_URL_LENGTH=24000;

export async function compressRoundPhoto(file,{bitmapFactory=globalThis.createImageBitmap,canvasFactory=()=>document.createElement('canvas')}={}) {
  if(!ALLOWED_IMAGE_TYPES.has(file?.type) || !Number.isFinite(file.size) || file.size>MAX_SOURCE_BYTES) throw new Error('Bitte wähle ein JPEG, PNG oder WebP unter 20 MB.');
  if(typeof bitmapFactory!=='function') throw new Error('Fotoverarbeitung wird von diesem Browser nicht unterstützt.');
  const bitmap=await bitmapFactory(file);
  try {
    if(!Number.isFinite(bitmap.width)||!Number.isFinite(bitmap.height)||bitmap.width<1||bitmap.height<1) throw new Error('Das Foto konnte nicht gelesen werden.');
    if(bitmap.width*bitmap.height>50_000_000) throw new Error('Das Bild hat eine zu hohe Auflösung. Bitte ein kleineres Foto wählen.');
    for(let maxEdge=640;maxEdge>=128;maxEdge=Math.floor(maxEdge*.78)) {
      const scale=Math.min(1,maxEdge/bitmap.width,maxEdge/bitmap.height);
      const canvas=canvasFactory(); canvas.width=Math.max(1,Math.round(bitmap.width*scale)); canvas.height=Math.max(1,Math.round(bitmap.height*scale));
      const context=canvas.getContext('2d',{alpha:false});
      if(!context) throw new Error('Foto kann auf diesem Gerät nicht verarbeitet werden.');
      context.drawImage(bitmap,0,0,canvas.width,canvas.height);
      for(const quality of [.72,.62,.52,.42,.32,.24,.18]) {
        const data=canvas.toDataURL('image/jpeg',quality);
        if(data.length<=MAX_UPLOAD_DATA_URL_LENGTH) return data;
      }
    }
    throw new Error('Foto konnte nicht klein genug komprimiert werden. Bitte näher heranzoomen und erneut aufnehmen.');
  } finally { bitmap.close?.(); }
}
