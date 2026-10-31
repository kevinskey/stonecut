export interface ProjectVersion { id: string; name: string; createdAt: number; stones: number; preview?: string; data: string }
export type VersionSummary = Omit<ProjectVersion, 'data'>
function open(): Promise<IDBDatabase> {
  return new Promise((resolve,reject) => {
    const r=indexedDB.open('stonecut-project-versions',1)
    r.onupgradeneeded=()=>r.result.createObjectStore('versions',{keyPath:'id'}).createIndex('createdAt','createdAt')
    r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)
  })
}
export async function saveProjectVersion(name: string, data: string, stones: number, preview?: string): Promise<void> {
  const db=await open()
  try { await new Promise<void>((resolve,reject)=>{
    const tx=db.transaction('versions','readwrite')
    tx.objectStore('versions').put({id:crypto.randomUUID(),name:name.trim()||'Untitled design',data,stones,preview,createdAt:Date.now()})
    tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error)
  }) } finally {db.close()}
}
export async function listProjectVersions(): Promise<VersionSummary[]> {
  const db=await open()
  try {return await new Promise<VersionSummary[]>((resolve,reject)=>{
    const rows:VersionSummary[]=[]
    const req=db.transaction('versions').objectStore('versions').index('createdAt').openCursor(null,'prev')
    req.onerror=()=>reject(req.error)
    req.onsuccess=()=>{
      const cursor=req.result
      if(!cursor||rows.length===50){resolve(rows);return}
      const {data: _data,...summary}=cursor.value as ProjectVersion
      rows.push(summary);cursor.continue()
    }
  })} finally {db.close()}
}
export async function readProjectVersion(id:string): Promise<ProjectVersion> {
  const db=await open()
  try{return await new Promise((resolve,reject)=>{
    const r=db.transaction('versions').objectStore('versions').get(id)
    r.onsuccess=()=>r.result?resolve(r.result):reject(new Error('Saved version was not found'));r.onerror=()=>reject(r.error)
  })}finally{db.close()}
}
