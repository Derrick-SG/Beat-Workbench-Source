export function preserveSegmentedTiming(existing,record){
  if(!existing?.timeSegments)return record;
  if(['workDate','startTime','endTime'].some(key=>existing[key]!==record[key]))throw Error('计时记录的日期和时段由实际计时保存，请保持原值；可修改项目、标题和其他内容。');
  return {...record,hours:existing.hours,timeSegments:structuredClone(existing.timeSegments),...(existing.sessionId?{sessionId:existing.sessionId}:{})};
}
export function splitTimeSegments(segments){
  const output=[];
  for(const segment of segments){
    if(!segment || !Number.isFinite(segment.start)||!Number.isFinite(segment.end)||segment.end<segment.start||!Number.isFinite(new Date(segment.start).getTime())||!Number.isFinite(new Date(segment.end).getTime()))throw Error('工作分段时间无效');
    for(let start=segment.start;start<segment.end;){const end=Math.min(start+86400000,segment.end);output.push({start,end});if(output.length>10000)throw Error('工作分段数量过多');start=end;}
  }
  return output;
}
export function segmentHours(segments){return segments.reduce((n,s)=>n+Math.max(0,s.end-s.start),0)/3600000;}
export function recordsInRange(items,range=null){
  const output=[];
  for(const item of items){
    if(!Array.isArray(item.timeSegments)||item._ranges){if(!range||(item.workDate>=range.start&&item.workDate<=range.end))output.push(item);continue;}
    const days=new Map();
    for(const segment of item.timeSegments){
      if(!Number.isFinite(segment.start)||!Number.isFinite(segment.end)||segment.end<segment.start)throw Error('工作分段时间无效');
      for(let cursor=segment.start;cursor<segment.end;){
        const d=new Date(cursor),midnight=new Date(d.getFullYear(),d.getMonth(),d.getDate()),next=new Date(d.getFullYear(),d.getMonth(),d.getDate()+1).getTime();
        const end=Math.min(next,segment.end),key=d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
        if(!range||(key>=range.start&&key<=range.end)){if(!days.has(key))days.set(key,[]);days.get(key).push({start:(cursor-midnight.getTime())/60000,end:(end-midnight.getTime())/60000,project:item.project||'未归类项目'});}
        cursor=end;
      }
    }
    for(const [workDate,ranges] of days)output.push({...item,workDate,_ranges:ranges,hours:ranges.reduce((n,r)=>n+r.end-r.start,0)/60});
  }
  return output;
}

function statRangeFor(item){const parse=t=>{const m=String(t||'').match(/^(\d{2}):(\d{2})$/);return m&&Number(m[1])<24&&Number(m[2])<60?Number(m[1])*60+Number(m[2]):null;};const start=parse(item.startTime);if(start===null)return null;let end=parse(item.endTime);if(end===null)end=start+Math.max(1,Number(item.hours)||1)*60;if(end<=start)end+=1440;return {start,end,project:item.project||'未归类项目'};}
export function timeStatsFor(items) {
      const itemsByDay = Object.create(null);
      recordsInRange(items).forEach((item) => { (itemsByDay[item.workDate] ||= []).push(item); });
      const projectMinutes = Object.create(null);
      let totalMinutes = 0;
      Object.values(itemsByDay).forEach((dayItems) => {
        const ranges = dayItems.flatMap(item => item._ranges || [statRangeFor(item)]).filter(Boolean);
        if (!ranges.length) return;
        const markers = [...new Set(ranges.flatMap((range) => [range.start, range.end]))].sort((a, b) => a - b);
        for (let index = 0; index < markers.length - 1; index += 1) {
          const start = markers[index];
          const end = markers[index + 1];
          const activeProjects = [...new Set(ranges.filter((range) => range.start < end && range.end > start).map((range) => range.project))];
          if (!activeProjects.length) continue;
          totalMinutes += end - start;
          const share = (end - start) / activeProjects.length;
          activeProjects.forEach((project) => { projectMinutes[project] = (projectMinutes[project] || 0) + share; });
        }
      });
      return {
        total: totalMinutes / 60,
        projectHours: Object.fromEntries(Object.entries(projectMinutes).map(([project, minutes]) => [project, minutes / 60]))
      };
    }
