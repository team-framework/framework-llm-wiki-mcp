import { hashContent } from './sections.js';

export type WikiDisplay = {title?: string;content?: string;source_hash?: string;body_hash: string;stale: boolean};
const keys = ['DisplayTitle','DisplayContent','DisplaySourceHash','display_title','display_content','display_source_hash'];

/** Display prose is presentation metadata; retrieval continues to use the canonical body. */
export function displayMetadata(metadata: Record<string,unknown>, body: string): {metadata: Record<string,unknown>;display?: WikiDisplay} {
  const text = (key:string, alias:string, max:number) => {
    const value=metadata[key]??metadata[alias];
    return typeof value==='string'&&value.trim()&&value.length<=max ? value.trim():undefined;
  };
  const title=text('DisplayTitle','display_title',200);
  const content=text('DisplayContent','display_content',30000);
  const source_hash=text('DisplaySourceHash','display_source_hash',64);
  const result=Object.fromEntries(Object.entries(metadata).filter(([key])=>!keys.includes(key)));
  if (!title&&!content) return {metadata:result};
  const body_hash=hashContent(body);
  return {metadata:result,display:{title,content,source_hash,body_hash,stale:Boolean(source_hash&&source_hash!==body_hash)}};
}
