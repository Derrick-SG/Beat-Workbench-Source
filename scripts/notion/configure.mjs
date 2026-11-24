import path from 'node:path';
import {homedir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {secureDirectory,atomicJson} from './store.mjs';
import {validatePrivateDirectory} from './private-path.mjs';
const diagnostics={
 token:{exitCode:2,message:'令牌不完整或格式无效，未保存。请重新复制完整内部连接令牌；不要发送到聊天。'},
 parent:{exitCode:3,message:'父页ID无效，未保存。请输入32位ID或标准带横线UUID，不要输入整段页面链接。'},
 path:{exitCode:4,message:'私有配置目录不安全或无法验证，未保存。请使用当前用户本地目录，避开工程、百度同步和OneDrive。'},
 access:{exitCode:5,message:'无法建立或验证私有目录权限，未保存。请使用当前Windows用户的本地目录，核对目录是否可访问及是否包含非普通文件。'},
 write:{exitCode:6,message:'私有配置写入或原子替换失败，未确认保存成功。请检查本地磁盘空间、文件占用后重试。'},
 unknown:{exitCode:1,message:'本机配置未保存成功，发生未识别的本机错误。请将此分类提示告知PM，不要发送令牌。'}
};
class ConfigurationError extends Error{constructor(kind){super(diagnostics[kind].message);this.kind=kind;}}
export function configurationDiagnostic(error){return {...diagnostics[error instanceof ConfigurationError?error.kind:'unknown']};}
export function privateDirectory(){return path.join(process.env.LOCALAPPDATA||path.join(homedir(),'.local','share'),'Beat-Workbench','notion');}
export async function configure({dir=privateDirectory(),token,parentPageId}){
 token=typeof token==='string'?token.trim():'';parentPageId=typeof parentPageId==='string'?parentPageId.trim():'';
 if(!/^[A-Za-z0-9_-]{20,500}$/.test(token))throw new ConfigurationError('token');
 if(!/^(?:[a-fA-F0-9]{32}|[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12})$/.test(parentPageId))throw new ConfigurationError('parent');parentPageId=parentPageId.replaceAll('-','');
 try{await validatePrivateDirectory(dir);}catch(e){throw new ConfigurationError(['EACCES','EPERM'].includes(e.code)?'access':'path');}
 try{await secureDirectory(dir);}catch{throw new ConfigurationError('access');}
 try{await atomicJson(path.join(dir,'config.json'),{token,parentPageId});}catch(e){throw new ConfigurationError(['EACCES','EPERM'].includes(e.code)?'access':'write');}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){const token=process.env.BW_NOTION_TOKEN,parentPageId=process.env.BW_NOTION_PARENT;delete process.env.BW_NOTION_TOKEN;delete process.env.BW_NOTION_PARENT;try{await configure({token,parentPageId});console.log('Notion本机配置已安全保存。请在工作台检查连接并确认首次同步范围。');}catch(error){const diagnostic=configurationDiagnostic(error);console.error(diagnostic.message);process.exitCode=diagnostic.exitCode;}}
