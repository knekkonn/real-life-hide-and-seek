import test from 'node:test';
import assert from 'node:assert/strict';
import { compressRoundPhoto } from '../js/photos.js';

test('round photos are re-encoded smaller than the server upload limit, including large phone images', async () => {
  const canvasSizes=[]; let closed=false;
  const image={width:4032,height:3024,close(){closed=true;}};
  const data=await compressRoundPhoto({type:'image/jpeg',size:15*1024*1024},{
    bitmapFactory:async()=>image,
    canvasFactory:()=>({
      width:0,height:0,
      getContext:()=>({drawImage(){}}),
      toDataURL(type,quality){canvasSizes.push(Math.max(this.width,this.height));return `data:${type};base64,${'A'.repeat(this.width>320?26000:12000)}`;}
    })
  });
  assert.ok(data.startsWith('data:image/jpeg;base64,'));
  assert.ok(data.length<=24000);
  assert.ok(canvasSizes.some(size=>size<=320),'retries at a smaller resolution if quality reduction is not enough');
  assert.equal(closed,true,'decoded image memory is released');
});

test('compressed photos always fit the Worker pixel limits, even when a large image compresses easily', async () => {
  for (const image of [{width:4032,height:3024},{width:3024,height:4032}]) {
    let encodedSize;
    await compressRoundPhoto({type:'image/jpeg',size:8*1024*1024},{
      bitmapFactory:async()=>image,
      canvasFactory:()=>({
        width:0,height:0,
        getContext:()=>({drawImage(){}}),
        toDataURL(type) { encodedSize={width:this.width,height:this.height}; return `data:${type};base64,${'A'.repeat(100)}`; }
      })
    });
    assert.ok(encodedSize.width<=320 && encodedSize.height<=240,`${image.width}×${image.height} was reduced to an accepted size`);
  }
});

test('round photo compression rejects unsupported or excessive source files before decoding', async () => {
  let decoded=false;
  const bitmapFactory=async()=>{decoded=true;return {width:1,height:1};};
  await assert.rejects(compressRoundPhoto({type:'image/gif',size:100},{bitmapFactory}),/JPEG-, PNG-, WebP- oder HEIC/);
  await assert.rejects(compressRoundPhoto({type:'image/jpeg',size:31*1024*1024},{bitmapFactory}),/unter 30 MB/);
  assert.equal(decoded,false);
});

test('phone formats and missing MIME types are decoded and re-encoded without metadata', async () => {
  const jpegHeader=Uint8Array.from([0xff,0xd8,0xff,0xe0,0,16,0,0,0,0,0,0,0,0,0,0]);
  let fallbackUsed=false,closed=false;
  const data=await compressRoundPhoto({type:'',size:2048,slice:()=>({arrayBuffer:async()=>jpegHeader.buffer})},{
    bitmapFactory:async()=>{throw new Error('createImageBitmap cannot decode this file');},
    imageFactory:async()=>{fallbackUsed=true;return {image:{width:4000,height:3000},close(){closed=true;}};},
    canvasFactory:()=>({width:0,height:0,getContext:()=>({drawImage(){}}),toDataURL(type){return `data:${type};base64,${'A'.repeat(5000)}`;}})
  });
  assert.ok(data.startsWith('data:image/jpeg;base64,'));
  assert.equal(fallbackUsed,true,'the browser image decoder is used if createImageBitmap fails');
  assert.equal(closed,true,'fallback object URLs or decoded resources are released');
});

test('HEIC camera files are offered to the browser decoder for safe JPEG conversion', async () => {
  const header=new Uint8Array(16); header.set([0,0,0,16,0x66,0x74,0x79,0x70,0x68,0x65,0x69,0x63]);
  let decodedType='';
  const data=await compressRoundPhoto({type:'image/heic',size:2*1024*1024,slice:()=>({arrayBuffer:async()=>header.buffer})},{
    bitmapFactory:async file=>{decodedType=file.type;return {width:4032,height:3024};},
    canvasFactory:()=>({width:0,height:0,getContext:()=>({drawImage(){}}),toDataURL(type){return `data:${type};base64,${'A'.repeat(1000)}`;}})
  });
  assert.equal(decodedType,'image/heic');
  assert.ok(data.startsWith('data:image/jpeg;base64,'));
});
