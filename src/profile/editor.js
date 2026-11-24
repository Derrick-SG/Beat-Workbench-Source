export function validateName(value,profiles,profileId) {
  const name=String(value).trim();
  if (!name) throw Error('请输入显示名称');
  if (name.length>30) throw Error('显示名称不能超过30字符');
  if (profiles.some(p=>p.id!==profileId && p.name===name)) throw Error('已有同名工作区，请换一个名称');
  return name;
}
export async function saveProfileDraft(controller,profileId,draft) {
  const name=validateName(draft.name,controller.getWorkspace().profiles,profileId);
  return controller.commit(w=>{
    const profile=w.profiles.find(p=>p.id===profileId);
    if (!profile) throw Error('工作区不存在');
    profile.name=name; profile.avatar=structuredClone(draft.avatar); return w;
  });
}
