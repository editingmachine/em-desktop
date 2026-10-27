import 
{
 describe, it, expect, afterEach, vi 
}
 from "vitest"
;

import fs from "node:fs"
;

import os from "node:os"
;

import path from "node:path"
;

import http from "node:http"
;

import 
{
 ProjectSync, safePath, retired, shouldReadmitUpload 
}
 from "./project-sync"
;

import 
{
 SyncEngine 
}
 from "./sync-engine"
;

const roots = []
;

afterEach(() => 
{
 vi.restoreAllMocks()
;
 for (const root of roots.splice(0)) fs.rmSync(root, 
{
 recursive: true, force: true 
}
)
;
 
}
)
;

function fixture() 
{

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "project-sync-"))
;

  roots.push(root)
;

  const store = new Map()
;

  const engine = 
{

    apiBase: "https://example.invalid", user: 
{
 id: 1, role: "editor" 
}
, token: "session",
    config: 
{
 getSyncFolder: () => root, config: 
{
 get: (k) => store.get(k), set: (k,v) => store.set(k, structuredClone(v)) 
}
 
}
,
    _fileDownloadInflight: new Map(), emit() 
{
}
,
  
}
;

  const sync = new ProjectSync(engine)
;

  sync.watch = () => 
{
}
;

  const project = 
{
 projectId: 9, clientId:1, projectName:"Project", projectCode: "001-0001", relativeDirectory: "Client-1/001-0001", status: "editing", lifecycleState:"active", get retired() 
{
 return retired(this)
;
 
}
, revision: "r1" 
}
;

  const manifest = 
{
 version: 2, complete: true, accountId: 1, generatedAt: new Date().toISOString(), projects: [project], files: [], totalFiles:0 
}
;

  return {
 root, engine, sync, project, manifest 
}
;

}

describe("project sync filesystem safety", () => 
{

  it("resumes server-known multipart gaps rather than trusting locally journaled parts", async () => 
{

    const 
{
 root, sync, manifest, project, engine 
}
 = fixture()
;

    await sync.reconcile(manifest)
;

    const file = path.join(root, project.relativeDirectory, "source.mp4")
;

    fs.writeFileSync(file, "abcdef")
;

    const received = []
;

    const server = http.createServer(async (req, res) => 
{

      const chunks = []
;

      for await (const chunk of req) chunks.push(chunk)
;

      received.push(Buffer.concat(chunks).toString())
;

      res.writeHead(200, 
{
 ETag: '"part-one"' 
}
)
;
 res.end()
;

    
}
)
;

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
;

    try 
{

      const item = 
{
 ...sync.scan(project.relativeDirectory)[0], relativePath: "source.mp4", assetId: 44,
        admission: 
{
 uploadId: "owned-upload", partSize: 3, partUrls: ["expired-1", "expired-2"] 
}
,
        parts: [
{
 PartNumber: 1, ETag: '"stale-local-part"' 
}
] 
}
;

      engine._json = vi.fn(async (_method, route, body) => 
{

        if (route.includes("/multipart-parts?")) return {
 assetId: 44, projectId: project.projectId,
          sha256: item.sha256, size: 6, uploadId: "owned-upload", partSize: 3, numberOfParts: 2,
          parts: [
{
 PartNumber: 2, ETag: '"server-part-two"' 
}
] 
}
;

        if (route.includes("/multipart-part-url?")) 
{

          expect(body.partNumber).toBe(1)
;

          return {
 partNumber: 1, uploadUrl: `http://127.0.0.1:${server.address().port}/part` 
}
;

        
}

        if (route.includes("/complete-multipart?")) 
{

          expect(body.parts).toEqual([
{
 PartNumber: 1, ETag: '"part-one"' 
}
, 
{
 PartNumber: 2, ETag: '"server-part-two"' 
}
])
;

          return {
}
;

        
}

        throw new Error("Unexpected route")
;

      
}
)
;

      sync.receipt = async () => 
{
}
;

      await sync.upload(
{
 id: project.projectId 
}
, item, file)
;

      expect(received).toEqual(["abc"])
;

      expect(item.transferred).toBe(true)
;

    
}
 finally 
{
 await new Promise((resolve) => server.close(resolve))
;
 
}

  
}
)
;

  it.each(["client", "sub-client", undefined])("never retires originals for role %s", async (role) => 
{

    const 
{
 root, sync, manifest, project, engine 
}
 = fixture()
;

    await sync.reconcile(manifest)
;

    const dir = path.join(root, project.relativeDirectory)
;

    fs.writeFileSync(path.join(dir, "source.mp4"), "precious original")
;

    project.status = "approved"
;

    engine.user.role = role
;

    engine._json = vi.fn()
;

    await sync.reconcile(manifest)
;

    expect(fs.readFileSync(path.join(dir, "source.mp4"), "utf8")).toBe("precious original")
;

    expect(sync.status[0].message).toContain("never automatically removed")
;

    expect(engine._json).not.toHaveBeenCalled()
;

    await expect(sync.retire(project, 
{
}
, [])).rejects.toThrow("never automatically removed")
;

  
}
)
;

  it("rejects a replaced session even when account and root are unchanged", async () => 
{

    const 
{
 sync, manifest, engine 
}
 = fixture()
;

    await sync.reconcile(manifest)
;

    engine.token = "replacement-session"
;

    expect(() => sync.check()).toThrow("Sync interrupted")
;

    expect(() => sync.save()).toThrow("Session changed")
;

  
}
)
;

  it("cancels active uploads on pause and stop", () => 
{

    const engine = new SyncEngine()
;

    const destroy = vi.fn()
;

    engine.projectSync.transfers.add(
{
 destroy 
}
)
;

    engine.pause()
;

    expect(destroy).toHaveBeenCalledTimes(1)
;

    engine.stop()
;

    expect(destroy).toHaveBeenCalledTimes(2)
;

  
}
)
;

  it("does not accept an admission returned after the session changes", async () => 
{

    const 
{
 root, sync, manifest, project, engine 
}
 = fixture()
;

    await sync.reconcile(manifest)
;

    const file = path.join(root, project.relativeDirectory, "source.mp4")
;

    fs.writeFileSync(file, "precious")
;

    const item = 
{
 ...sync.scan(project.relativeDirectory)[0], relativePath: "source.mp4" 
}
;

    engine._json = vi.fn(async () => 
{

      engine.token = "new-login"
;

      return {
 assetId: 100, uploadUrl: "https://example.invalid/never-put" 
}
;

    
}
)
;

    await expect(sync.upload(
{
 id: project.projectId 
}
, item, file)).rejects.toThrow("Sync interrupted")
;

    expect(item.assetId).toBeUndefined()
;

    expect(engine._json).toHaveBeenCalledTimes(1)
;

  
}
)
;

  it("only final approval/archive retires", () => 
{

    for (const status of ["approved", "archive", "archived"]) expect(retired(
{
status
}
)).toBe(true)
;

    for (const status of ["review", "revision", "editing", "completed", "draft"]) expect(retired(
{
status
}
)).toBe(false)
;

    expect(retired(
{
status:"editing", lifecycleState:"parked"
}
)).toBe(false)
;

    expect(retired(
{
status:"editing", lifecycleState:"archived"
}
)).toBe(true)
;

  
}
)
;

  it("re-admits transfers when stored bytes are missing or corrupt", () => 
{

    expect(shouldReadmitUpload(new Error("Uploaded object is missing."))).toBe(true)
;

    expect(shouldReadmitUpload(new Error("Stored bytes do not match the latest local version; re-upload required."))).toBe(true)
;

    expect(shouldReadmitUpload(new Error("Upload HTTP 403"))).toBe(true)
;

    expect(shouldReadmitUpload(new Error("Asset processing is still pending"))).toBe(false)
;

  
}
)
;

  it("rejects roots, traversal and links", () => 
{

    const 
{
root
}
 = fixture()
;

    for (const relative of ["", "../x", "/tmp/x", "a/../b", "a\\b"]) expect(() => safePath(root, relative)).toThrow()
;

    fs.symlinkSync(os.tmpdir(), path.join(root, "link"))
;

    expect(() => safePath(root, "link/file")).toThrow()
;

  
}
)
;

  it("never adopts a pre-existing folder by its number alone", async () => 
{

    const 
{
root,sync,manifest,project
}
 = fixture()
;

    const dir = path.join(root, project.relativeDirectory)
;

    fs.mkdirSync(dir,
{
recursive:true
}
)
;
 fs.writeFileSync(path.join(dir,"manual.prproj"),"precious")
;

    await sync.reconcile(manifest)
;

    expect(sync.status[0].state).toBe("blocked")
;

    expect(fs.readFileSync(path.join(dir,"manual.prproj"),"utf8")).toBe("precious")
;

  
}
)
;

  it("keeps unsupported hidden/operator files and persists the queue", async () => 
{

    const 
{
root,sync,manifest,project
}
 = fixture()
;

    await sync.reconcile(manifest)
;

    fs.writeFileSync(path.join(root,project.relativeDirectory,".edit.prproj"),"precious")
;

    sync.stabilityMs = 0
;

    await sync.reconcile(manifest)
;

    expect(sync.status[0].state).toBe("blocked")
;

    expect(sync.status[0].message).toContain("Unsupported")
;

    expect(Object.values(sync.data.queue)[0].state).toBe("blocked")
;

  
}
)
;

  it("rejects malformed manifests and account switches", async () => 
{

    const 
{
sync,manifest,engine
}
 = fixture()
;

    await expect(sync.reconcile(
{
...manifest,complete:false
}
)).rejects.toThrow()
;

    await sync.reconcile(manifest)
;

    engine.user = 
{
id:2
}
;

    expect(() => sync.save()).toThrow()
;

    await expect(sync.reconcile(manifest)).rejects.toThrow()
;

  
}
)
;

  it("retains a late write made while cloud coverage is being verified", async () => 
{

    const 
{
root,sync,manifest,project,engine
}
 = fixture()
;

    await sync.reconcile(manifest)
;

    const relative = `${project.relativeDirectory}/manual.mp4`
;

    const abs = path.join(root,relative)
;

    fs.writeFileSync(abs,"first")
;

    sync.stabilityMs = 0
;

    sync.upload = async (_p,item) => 
{
 item.assetId = 10
;
 
}
;

    await sync.reconcile(manifest)
;

    project.status = "approved"
;

    engine._json = async () => (
{
 ...manifest, project 
}
)
;

    sync.receipt = async () => 
{
 fs.writeFileSync(abs,"late changed version")
;
 
}
;

    await sync.reconcile(manifest)
;

    expect(sync.status[0].state).toBe("blocked")
;

    expect(fs.readFileSync(abs,"utf8")).toBe("late changed version")
;

  
}
)
;

  it("fences then removes all verified manual and hidden contents, never the client parent", async () => 
{

    const 
{
root,sync,manifest,project,engine
}
 = fixture()
;

    await sync.reconcile(manifest)
;

    const dir = path.join(root,project.relativeDirectory)
;

    fs.mkdirSync(path.join(dir,"nested"))
;

    fs.writeFileSync(path.join(dir,"nested",".manual.mp4"),"first")
;

    fs.writeFileSync(path.join(dir,".DS_Store"),"metadata")
;

    sync.stabilityMs = 0
;

    sync.upload = async (_p,item) => 
{
 item.assetId = 10
;
 
}
;

    sync.receipt = async () => 
{
}
;

    await sync.reconcile(manifest)
;

    project.status = "approved"
;

    engine._json = async () => (
{
 ...manifest, project 
}
)
;

    await sync.reconcile(manifest)
;

    expect(sync.status[0].state).toBe("blocked")
;

    expect(fs.existsSync(dir)).toBe(false)
;

    await sync.reconcile(manifest)
;

    expect(sync.status[0].state).toBe("retired")
;

    expect(fs.existsSync(path.dirname(dir))).toBe(true)
;

    expect(fs.readdirSync(path.dirname(dir))).toEqual([])
;

    expect(sync.data.reclaimedBytes).toBe(13)
;

  
}
)
;

  it("blocks normalized Unicode aliases and same-device bind mounts", () => 
{

    const 
{
root
}
 = fixture()
;

    fs.mkdirSync(path.join(root,"caf\u00e9"))
;

    fs.mkdirSync(path.join(root,"cafe\u0301"))
;

    expect(() => safePath(root,"caf\u00e9/file")).toThrow(/conflict/)
;

    fs.mkdirSync(path.join(root,"mounted"))
;

    const read = fs.readFileSync
;

    vi.spyOn(fs,"readFileSync").mockImplementation((file,...args) =>
      file === "/proc/self/mountinfo" ? `1 2 0:1 / ${root}/mounted rw - ext4 /dev/sda rw\n` : read(file,...args))
;

    expect(() => safePath(root,"mounted/file")).toThrow(/bind/)
;

  
}
)
;

  it("blocks a different device beneath the root", () => 
{

    const 
{
root
}
 = fixture()
;

    const directory = path.join(root,"device")
;

    fs.mkdirSync(directory)
;

    const stat = fs.lstatSync
;

    vi.spyOn(fs,"lstatSync").mockImplementation((file,...args) => 
{

      const result = stat(file,...args)
;

      if (file === directory) Object.defineProperty(result,"dev",
{
value:result.dev+1
}
)
;

      return result
;

    
}
)
;

    expect(() => safePath(root,"device/file")).toThrow(/device/)
;

  
}
)
;

  it("explicit identity confirmation migrates all legacy bytes and resumes a journal after restart", async () => 
{

    const 
{
root,sync,manifest,project,engine
}
 = fixture()
;

    await sync.reconcile(manifest)
;

    const legacy = "Legacy-Client/Shared-Title"
;

    fs.mkdirSync(path.join(root,legacy),
{
recursive:true
}
)
;

    fs.writeFileSync(path.join(root,legacy,".manual.prproj"),"precious")
;

    engine._json = async () => manifest
;

    await expect(sync.mapLegacyDirectory(9,legacy,"wrong")).rejects.toThrow(/confirmation/)
;

    await sync.mapLegacyDirectory(9,legacy,project.projectCode)
;

    const restarted = new ProjectSync(engine)
;
 restarted.watch = () => 
{
}
;

    await restarted.reconcile(manifest)
;

    expect(fs.existsSync(path.join(root,legacy))).toBe(false)
;

    expect(fs.readFileSync(path.join(root,project.relativeDirectory,".manual.prproj"),"utf8")).toBe("precious")
;

    expect(restarted.data.projects[9].migratedFrom).toBe(legacy)
;

  
}
)
;

  it("rejects another project's unclaimed canonical directory, including case aliases", async () => 
{

    const 
{
root,sync,manifest,project,engine
}
 = fixture()
;

    const other = 
{
...project, projectId:10, projectCode:"001-0002", relativeDirectory:"Client-1/001-0002"
}
;

    manifest.projects.push(other)
;

    const directory = path.join(root,other.relativeDirectory)
;

    fs.mkdirSync(directory,
{
recursive:true
}
)
;

    fs.writeFileSync(path.join(directory,".manual.prproj"),"belongs to B")
;

    engine._json = async () => manifest
;

    for (const source of [other.relativeDirectory, other.relativeDirectory.toLowerCase()]) 
{

      await expect(sync.mapLegacyDirectory(project.projectId,source,project.projectCode)).rejects.toThrow(/canonical numbered/)
;

    
}

    expect(sync.data.projects[10]).toBeUndefined()
;

    expect(sync.data.legacyMappings?.[9]).toBeUndefined()
;

    expect(fs.readFileSync(path.join(directory,".manual.prproj"),"utf8")).toBe("belongs to B")
;

    expect(fs.existsSync(path.join(root,project.relativeDirectory))).toBe(false)
;

  
}
)
;

  it("refuses nonempty migration destinations and duplicate source claims", async () => 
{

    const 
{
root,sync,manifest,project,engine
}
 = fixture()
;

    await sync.reconcile(manifest)
;

    const legacy = "Legacy-Client/Title"
;

    fs.mkdirSync(path.join(root,legacy),
{
recursive:true
}
)
;

    fs.writeFileSync(path.join(root,project.relativeDirectory,"operator.mp4"),"canonical")
;

    engine._json = async () => manifest
;

    await expect(sync.mapLegacyDirectory(9,legacy,project.projectCode)).rejects.toThrow(/destination/)
;

    fs.unlinkSync(path.join(root,project.relativeDirectory,"operator.mp4"))
;

    sync.data.legacyMappings = 
{
10:legacy
}
;
 sync.save()
;

    await expect(sync.mapLegacyDirectory(9,legacy,project.projectCode)).rejects.toThrow(/assigned/)
;

    expect(fs.existsSync(path.join(root,legacy))).toBe(true)
;

  
}
)
;

  it("defers retirement for read/download leases and restores fenced bytes on reopen", async () => 
{

    const 
{
root,sync,manifest,project,engine
}
 = fixture()
;

    await sync.reconcile(manifest)
;

    project.status = "approved"
;

    engine._json = async () => (
{
...manifest,project
}
)
;

    sync.readers.set("playback",1)
;

    await sync.reconcile(manifest)
;

    expect(sync.status[0].message).toContain("playback")
;

    sync.readers.clear()
;

    engine._fileDownloadInflight.set("download",Promise.resolve())
;

    await sync.reconcile(manifest)
;

    expect(sync.status[0].message).toContain("Download")
;

    engine._fileDownloadInflight.clear()
;

    await sync.reconcile(manifest)
;

    expect(sync.data.projects[9].fencedDirectory).toBeTruthy()
;

    project.status = "revision"
;

    await sync.reconcile(manifest)
;

    expect(sync.data.projects[9].fencedDirectory).toBeUndefined()
;

    expect(fs.existsSync(path.join(root,project.relativeDirectory))).toBe(true)
;

  
}
)
;

  it("preserves active shared copies and retries locked retired files", async () => 
{

    const 
{
root,sync,manifest,project,engine
}
 = fixture()
;

    const active = 
{
...project,projectId:10,projectCode:"001-0002",relativeDirectory:"Client-1/001-0002"
}
;

    manifest.projects.push(active)
;

    await sync.reconcile(manifest)
;

    for (const p of manifest.projects) fs.writeFileSync(path.join(root,p.relativeDirectory,"shared.mp4"),"bytes")
;

    sync.stabilityMs = 0
;

    sync.upload = async (_p,item) => 
{
 item.assetId=10
;
 
}
;

    sync.receipt = async () => 
{
}
;

    await sync.reconcile(manifest)
;

    project.status = "approved"
;

    engine._json = async () => (
{
...manifest,project
}
)
;

    await sync.reconcile(manifest)
;

    const unlink = vi.spyOn(fs,"unlinkSync").mockImplementationOnce(() => 
{
 throw Object.assign(new Error("File locked; close editor and retry"),
{
code:"EBUSY"
}
)
;
 
}
)
;

    await sync.reconcile(manifest)
;

    expect(sync.status.find((p)=>p.projectId===9).message).toContain("locked")
;

    unlink.mockRestore()
;

    await sync.reconcile(manifest)
;

    expect(sync.status.find((p)=>p.projectId===9).state).toBe("retired")
;

    expect(fs.readFileSync(path.join(root,active.relativeDirectory,"shared.mp4"),"utf8")).toBe("bytes")
;

  
}
)
;

  it("retains archived late additions with a durable retry and restoration remedy", async () => 
{

    const 
{
root,sync,manifest,project,engine
}
 = fixture()
;

    await sync.reconcile(manifest)
;

    fs.writeFileSync(path.join(root,project.relativeDirectory,"late.mp4"),"bytes")
;

    project.status = "archive"
;

    sync.stabilityMs=0
;

    sync.upload = async () => 
{
 throw new Error("Archived project rejects upload")
;
 
}
;

    await sync.reconcile(manifest)
;

    const item = Object.values(sync.data.queue)[0]
;

    expect(item.retryAt).toBeGreaterThan(Date.now())
;

    expect(sync.status[0].message).toContain("Restore archived projects")
;

    const restarted = new ProjectSync(engine)
;
 restarted.watch=()=>
{
}
;

    await restarted.reconcile(manifest)
;

    expect(Object.values(restarted.data.queue)[0].attempts).toBe(1)
;

    expect(fs.existsSync(path.join(root,project.relativeDirectory,"late.mp4"))).toBe(true)
;

  
}
)
;

  it("rechecks retirement after slow cloud verification and preserves reopened projects", async () => 
{

    const 
{
root,sync,manifest,project,engine
}
 = fixture()
;

    await sync.reconcile(manifest)
;

    fs.writeFileSync(path.join(root,project.relativeDirectory,"manual.mp4"),"bytes")
;

    sync.stabilityMs=0
;

    sync.upload=async (_p,item)=>
{
item.assetId=10
;
}
;

    await sync.reconcile(manifest)
;

    project.status="approved"
;

    engine._json=async()=>(
{
...manifest,project:
{
...project
}
}
)
;

    sync.receipt=async()=>
{
project.status="editing"
;
}
;

    await sync.reconcile(manifest)
;

    expect(sync.status[0].state).toBe("blocked")
;

    expect(fs.existsSync(path.join(root,project.relativeDirectory,"manual.mp4"))).toBe(true)
;

  
}
)
;

  it("requires exact S3 coverage for downloaded bytes, never just a signed URL", async () => 
{

    const 
{
root,sync,manifest,project,engine
}
 = fixture()
;

    await sync.reconcile(manifest)
;

    const relative = `${project.relativeDirectory}/proxy.mp4`
;

    fs.writeFileSync(path.join(root,relative),"bytes")
;

    sync.recordDownload(relative,
{
id:11,derivative:"proxy_intra"
}
)
;

    project.status="approved"
;

    engine._json=async (_method,route)=>route.includes("/coverage")
      ? 
{
url:"https://signed.invalid/object"
}
 : 
{
...manifest,project
}
;

    await sync.reconcile(manifest)
;

    expect(sync.status[0].message).toContain("coverage")
;

    expect(fs.existsSync(path.join(root,relative))).toBe(true)
;

    engine._json=async (_method,route)=>route.includes("/coverage")
      ? 
{
recoverable:true,assetId:11,projectId:9,derivative:"proxy_intra",sha256:sync.data.downloads[relative].sha256,size:5
}

      : 
{
...manifest,project
}
;

    await sync.reconcile(manifest)
;

    await sync.reconcile(manifest)
;

    expect(sync.status[0].state).toBe("retired")
;

  
}
)
;

  it("resumes server-deduplicated uploads using a receipt without re-uploading bytes", async () => 
{

    const 
{
root,sync,manifest,project,engine
}
 = fixture()
;

    await sync.reconcile(manifest)
;

    fs.writeFileSync(path.join(root,project.relativeDirectory,"manual.mp4"),"bytes")
;

    sync.stabilityMs=0
;

    const calls=[]
;

    engine._json=async (method,route,body)=>
{

      calls.push(route)
;

      if (route.endsWith("presigned-upload")) return {
assetId:33,alreadyUploaded:true
}
;

      const item=Object.values(sync.data.queue)[0]
;

      return {
recoverable:true,assetId:33,projectId:9,relativePath:body?.desktopSync?.relativePath || item.relativePath,sha256:item.sha256,size:item.size
}
;

    
}
;

    await sync.reconcile(manifest)
;

    expect(sync.status[0].state).toBe("ready")
;

    expect(Object.values(sync.data.queue)[0].state).toBe("verified")
;

    expect(calls).toHaveLength(2)
;

    expect(calls[1]).toContain("desktop-recoverability")
;

  
}
)
;

  it("validates the entire complete manifest before any project can retire", async () => 
{

    const 
{
root,sync,manifest,project,engine
}
=fixture()
;

    await sync.reconcile(manifest)
;

    project.status="approved"
;

    engine._json=async()=>(
{
...manifest,project
}
)
;

    const invalid = [
      
{
...manifest,totalFiles:undefined
}
,
      
{
...manifest,totalFiles:1
}
,
      
{
...manifest,totalFiles:-1
}
,
      
{
...manifest,projects:[
{
...project,clientId:"1"
}
]
}
,
      
{
...manifest,projects:[
{
...project,status:"complete"
}
]
}
,
      
{
...manifest,projects:[
{
...project,lifecycleState:"unknown"
}
]
}
,
      
{
...manifest,projects:[
{
...project,retired:false
}
]
}
,
      
{
...manifest,projects:[
{
...project,revision:23
}
]
}
,
      
{
...manifest,projects:[
{
...project,relativeDirectory:"Wrong-Client/001-0001"
}
]
}
,
      
{
...manifest,totalFiles:1,files:[
{
id:11,assetId:11,projectId:999,clientId:1,size:1,name:"x",relativePath:"Client-1/001-0001/x"
}
]
}
,
    ]
;

    for(const malformed of invalid) 
{

      await expect(sync.reconcile(malformed)).rejects.toThrow()
;

      expect(fs.existsSync(path.join(root,project.relativeDirectory))).toBe(true)
;

    
}

    project.status="editing"
;

    const file=
{
id:11,assetId:11,projectId:9,clientId:1,size:1,name:"x.mp4",relativePath:`${project.relativeDirectory}/x.mp4`
}
;

    for(const change of [
{
size:-1
}
,
{
size:"1"
}
,
{
assetId:12
}
,
{
clientId:2
}
,
{
relativePath:"Client-2/001-0001/x"
}
,
{
relativePath:`${project.relativeDirectory}/../x`
}
,
{
downloadPath:"https://evil.invalid/"
}
]) 
{

      await expect(sync.reconcile(
{
...manifest,totalFiles:1,files:[
{
...file,...change
}
]
}
)).rejects.toThrow()
;

    
}

  
}
)
;

  it("retains folders on malformed or incomplete retirement rechecks", async () => 
{

    const 
{
root,sync,manifest,project,engine
}
=fixture()
;

    await sync.reconcile(manifest)
;

    project.status="approved"
;

    for(const response of [
      
{
...manifest,complete:false,project
}
,
      
{
...manifest,generatedAt:"invalid",project
}
,
      
{
...manifest,project:
{
...project,retired:false
}
}
,
      
{
...manifest,project:
{
...project,clientId:99
}
}
,
      
{
...manifest,project:
{
...project,lifecycleState:null
}
}
,
    ]) 
{

      engine._json=async()=>response
;

      await sync.reconcile(manifest)
;

      expect(sync.status[0].state).toBe("blocked")
;

      expect(fs.existsSync(path.join(root,project.relativeDirectory))).toBe(true)
;

    
}

  
}
)
;

  it("accepts only explicitly marked exact recovery download routes and pinned identities", async () => 
{

    const 
{
sync,manifest,project
}
=fixture()
;

    const file=
{
id:11,assetId:11,projectId:9,clientId:1,size:5,name:"manual.mp4",
      relativePath:`${project.relativeDirectory}/operator-uploads/11/nested/manual.mp4`,
      desktopRecovery:true,homeProjectId:9,sha256:"a".repeat(64),
      downloadPath:"/api/smart-cloud/assets/11/desktop-recovery-download?desktopProjectId=9"
}
;

    await sync.reconcile(
{
...manifest,totalFiles:1,files:[file]
}
)
;

    await sync.reconcile(
{
...manifest,totalFiles:1,files:[
{
...file,desktopRecovery:undefined,homeProjectId:undefined,kind:"desktop_recovery",recoveryProjectId:9
}
]
}
)
;

    for(const change of [
      
{
desktopRecovery:false
}
,
{
desktopRecovery:undefined
}
,
{
homeProjectId:"9"
}
,
      
{
homeProjectId:10
}
,
{
assetId:12
}
,
{
sha256:undefined
}
,
{
sha256:"bad"
}
,
      
{
downloadPath:"/api/smart-cloud/assets/12/desktop-recovery-download?desktopProjectId=9"
}
,
      
{
downloadPath:file.downloadPath+"&extra=1"
}
,
      
{
relativePath:`${project.relativeDirectory}/operator-uploads/12/manual.mp4`
}
,
      
{
derivative:"proxy_intra"
}
,
{
recoveryProjectId:10
}
,
    ]) await expect(sync.reconcile(
{
...manifest,totalFiles:1,files:[
{
...file,...change
}
]
}
)).rejects.toThrow()
;

  
}
)
;

  it("restores exact pinned recovery bytes through the daemon without an upload loop", async () => 
{

    const 
{
root,manifest,project,engine:base
}
=fixture()
;

    const bytes=Buffer.from("bytes")
;

    const hash=require("crypto").createHash("sha256").update(bytes).digest("hex")
;

    const file=
{
id:11,assetId:11,projectId:9,clientId:1,size:5,name:"manual.mp4",
      relativePath:`${project.relativeDirectory}/operator-uploads/11/nested/manual.mp4`,
      desktopRecovery:true,homeProjectId:9,sha256:hash,
      downloadPath:"/api/smart-cloud/assets/11/desktop-recovery-download?desktopProjectId=9"
}
;

    const engine=new SyncEngine(
{
apiBase:base.apiBase,config:base.config,keychain:
{
}
,getDiskUsage:async()=>(
{
}
)
}
)
;

    engine.user=
{
id:1
}
;
 engine.token="session"
;
 engine.projectSync.watch=()=>
{
}
;

    const calls=[]
;

    engine._json=async (_method,route)=>
{

      calls.push(route)
;

      if(route==="/api/sync/manifest?version=2") return {
...manifest,totalFiles:1,files:[file]
}
;

      if(route===file.downloadPath) return {
url:"https://recovery.invalid/pinned"
}
;

      if(route.endsWith("/complete")) return {
success:true
}
;

      throw new Error("Unexpected request "+route)
;

    
}
;

    engine._download=async(_url,dest)=>
{

      fs.mkdirSync(path.dirname(dest),
{
recursive:true
}
)
;

      fs.writeFileSync(dest,bytes)
;

    
}
;

    await engine.syncOnce()
;

    expect(fs.readFileSync(path.join(root,file.relativePath))).toEqual(bytes)
;

    expect(engine.projectSync.data.downloads[file.relativePath].sha256).toBe(hash)
;

    await engine.syncOnce()
;

    expect(calls.filter((route)=>route===file.downloadPath)).toHaveLength(1)
;

    expect(Object.keys(engine.projectSync.data.queue)).toHaveLength(0)
;

  
}
)
;

}
)
;
