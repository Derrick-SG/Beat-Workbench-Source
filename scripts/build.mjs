import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
export function stampVersion(html,version){
  if(!/^\d+\.\d+\.\d+$/.test(version))throw Error('Invalid package version');
  const badge=/(<span\b[^>]*\bid="app-version"[^>]*>)[^<]*(<\/span>)/g;
  if([...html.matchAll(badge)].length!==1)throw Error('Source entry must contain exactly one version badge');
  return html.replace(badge,(_,start,end)=>start+'V'+version+end);
}
export async function bundleModule(entry) {
  const emitted=new Set(),visiting=new Set(),parts=['const __modules = {};'];
  async function visit(id){
    if(emitted.has(id))return;
    if(visiting.has(id))throw Error('Cyclic module import: '+id);visiting.add(id);
    let code=await readFile(path.join(root,id),'utf8');const bindings=[];
    const imports=[...code.matchAll(/^import \{([^}]+)\} from ['"]([^'"]+)['"];?\r?$/gm)];
    for(const item of imports){
      if(!item[2].startsWith('.'))throw Error('External module is unsupported');
      const child=path.posix.normalize(path.posix.join(path.posix.dirname(id),item[2]));
      if(!child.startsWith('src/'))throw Error('Module outside src');
      await visit(child);bindings.push('const {'+item[1].replace(/\bas\b/g,':')+'}=__modules['+JSON.stringify(child)+'];');code=code.replace(item[0],'');
    }
    if(/^\s*import\s/m.test(code)||/\bimport\s*\(/.test(code))throw Error('Unsupported import syntax in '+id);
    const exports=[...code.matchAll(/^export (?:async )?function ([A-Za-z_$][\w$]*)/gm)].map(m=>m[1]);
    code=code.replace(/^export (?=(?:async )?function )/gm,'');
    if(/^\s*export\s/m.test(code))throw Error('Unsupported export syntax in '+id);
    parts.push('__modules['+JSON.stringify(id)+']=await (async()=>{\n'+bindings.join('\n')+'\n'+code+'\nreturn {'+exports.join(',')+'};\n})();');
    visiting.delete(id);emitted.add(id);
  }
  await visit(entry);return parts.join('\n');
}
export async function build() {
  const [sourceHtml, css, js, metadata] = await Promise.all([readFile(path.join(root,'src/index.html'),'utf8'),readFile(path.join(root,'src/styles.css'),'utf8'),bundleModule('src/app.js'),readFile(path.join(root,'package.json'),'utf8')]);
  const html=stampVersion(sourceHtml,JSON.parse(metadata).version);
  // Keep the source served by the existing local server and standalone output in sync.
  if(html!==sourceHtml)await writeFile(path.join(root,'src/index.html'),html,'utf8');
  const styleTag = '<link rel="stylesheet" href="./styles.css">';
  const scriptTag = '<script type="module" src="./app.js"></script>';
  if (html.split(styleTag).length !== 2 || html.split(scriptTag).length !== 2) throw new Error('Source entry must contain exactly one stylesheet and application module reference.');
  // Callbacks preserve literal $ sequences in source code.
  const output = html.replace(styleTag, () => '<style>' + css + '</style>').replace(scriptTag, () => '<script type="module">' + js + '</script>');
  await mkdir(path.join(root, 'dist'), { recursive: true });
  const target = path.join(root, 'dist', '节拍工作台.html');
  await writeFile(target, output, 'utf8');
  return target;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) console.log(await build());
