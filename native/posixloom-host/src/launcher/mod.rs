mod integrity;
use integrity::*;
use serde::Deserialize;
use std::io::Write;
use std::process::Command;

/// 角色 A：启动器入口（永不返回）。
/// 流程：确定 RunRoot（POSIXLOOM_RUN_ROOT 优先，否则从 exe 位置向上探测）
/// -> 判定是否恢复命令 -> 选择 Node（正常路径严格校验、恢复路径放宽）
/// -> 用选出的 Node 运行 dist/src/cli/main.js 并透传其退出码。
/// Node 选择失败时直接以退出码 1 终止，绝不静默回退到不受信任的解释器。
pub(crate) fn launch(forwarded: Vec<std::ffi::OsString>) -> ! {
    // RunRoot 来源优先级：POSIXLOOM_RUN_ROOT 环境变量（显式覆盖，测试/嵌入部署用）
    // > 从 exe 位置向上探测 > 退化为当前目录。
    let root_value = std::env::var("POSIXLOOM_RUN_ROOT")
        .ok()
        .filter(|value| !value.is_empty())
        .or_else(find_project_root)
        .unwrap_or_else(|| ".".to_string());
    let root = match absolute_path(std::path::PathBuf::from(root_value)) {
        Ok(root) => root,
        Err(error) => {
            eprintln!("posixloom launcher: {error}");
            std::process::exit(1);
        }
    };
    // 公开命令参数原样透传；main 已移除可选的兼容 launch 前缀。
    // 恢复命令判定：runtime doctor/info/update/rollback 需要能诊断或修复坏掉的运行时
    // 指针，因此 Node 选择策略放宽（见 select_recovery_launcher_node）。
    let recovery_command = forwarded.first().and_then(|value| value.to_str()) == Some("runtime")
        && matches!(
            forwarded.get(1).and_then(|value| value.to_str()),
            Some("doctor" | "info" | "update" | "rollback")
        );
    let node = match if recovery_command {
        select_recovery_launcher_node(&root)
    } else {
        select_launcher_node(&root.to_string_lossy())
    } {
        Ok(node) => node,
        Err(error) => {
            eprintln!("posixloom launcher: {error}");
            std::process::exit(1);
        }
    };
    // 固定入口脚本：它位于 dist/ 下，属于应用包完整性校验的覆盖范围。
    let script = root.join("dist").join("src").join("cli").join("main.js");
    let status = Command::new(node).arg(script).args(forwarded).status();
    std::process::exit(status.map(|value| value.code().unwrap_or(1)).unwrap_or(1));
}

/// 从 exe 所在目录向上最多 6 层探测 PosixLoom 安装根（RunRoot）。
/// 认定标志是 package.json、dist/src/cli/main.js、config/defaults.json
/// 任意一个存在。层数上限避免在异常深的目录里一路扫到盘符根；
/// 找不到返回 None，由调用方决定回退。
fn find_project_root() -> Option<String> {
    let mut current = std::env::current_exe().ok()?.parent()?.to_path_buf();
    for _ in 0..6 {
        if current.join("package.json").exists()
            || current
                .join("dist")
                .join("src")
                .join("cli")
                .join("main.js")
                .exists()
            || current.join("config").join("defaults.json").exists()
        {
            return Some(current.to_string_lossy().into_owned());
        }
        if !current.pop() {
            break;
        }
    }
    None
}

/// 运行时清单中的单个组件描述（目前实际消费的只有 node 组件）。
#[derive(Deserialize)]
struct LauncherComponent {
    /// 组件标识，例如 "node"。
    id: String,
    /// 相对 Runtime 根目录的入口文件路径。
    entrypoint: String,
    /// 入口文件的 SHA-256（十六进制）；release 组件必须提供。
    sha256: Option<String>,
}

/// runtime/versions/<id>/manifest.json 的反序列化目标。
#[derive(Deserialize)]
struct LauncherManifest {
    /// 清单结构版本；release 路径目前只接受 1，未知版本宁可拒绝。
    #[serde(rename = "manifestVersion")]
    manifest_version: Option<u32>,
    /// 运行时 ID，必须与所在目录名一致（防目录与内容对不上）。
    #[serde(rename = "runtimeId")]
    runtime_id: String,
    /// "release" 或 "development"，必须与选择侧推断的模式一致。
    mode: Option<String>,
    /// 组件列表（node 等）。
    #[serde(default)]
    components: Vec<LauncherComponent>,
}

/// 校验运行时 ID 的合法形态：非空、最长 128、首字符必须是 ASCII 字母数字，
/// 其后额外允许 '.'、'_'、'-'。
/// ID 会被直接拼进 runtime/versions/<id> 路径，因此这里是路径遍历与
/// 分隔符注入的第一道防线："../outside"、"a/b" 等都会被拒绝。
fn valid_runtime_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.chars().enumerate().all(|(index, ch)| {
            ch.is_ascii_alphanumeric() || (index > 0 && matches!(ch, '.' | '_' | '-'))
        })
}

/// 把相对路径锚定到当前目录得到绝对路径；绝对路径原样返回。
/// 启动器的所有安全判定都基于绝对路径，避免后续相对路径拼接
/// 随 cwd 漂移产生歧义。
fn absolute_path(path: std::path::PathBuf) -> Result<std::path::PathBuf, String> {
    if path.is_absolute() {
        Ok(path)
    } else {
        std::env::current_dir()
            .map(|current| current.join(path))
            .map_err(|error| format!("cannot resolve current directory: {error}"))
    }
}

/// 实测某目录是否真的可写：先确保目录存在，再以独占方式写入并 fsync 一个
/// 一次性探测文件（带进程 ID 与纳秒时间戳，避免并发冲突），随后无论成败
/// 都删除。只有真正落盘成功才算通过--“目录存在”不等于“可写”，
/// 只读介质上的探测必须失败才能触发 DataRoot 的后续回退。
fn probe_writable_directory(directory: &std::path::Path) -> Result<(), String> {
    std::fs::create_dir_all(directory)
        .map_err(|error| format!("cannot create {}: {error}", directory.display()))?;
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let probe = directory.join(format!(
        ".posixloom-write-probe-{}-{nonce}",
        std::process::id()
    ));
    let result = (|| -> Result<(), String> {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&probe)
            .map_err(|error| format!("cannot write {}: {error}", directory.display()))?;
        file.write_all(b"posixloom")
            .map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())
    })();
    let _ = std::fs::remove_file(&probe);
    result
}

/// 与 TS 侧 config.ts 相同的 DataRoot 探测顺序：
///   1. POSIXLOOM_DATA_ROOT 环境变量（显式指定；创建失败直接报错，不再回退）；
///   2. RunRoot 下的 data/（真正的便携模式；写探测失败才继续回退）；
///   3. LOCALAPPDATA，或 USERPROFILE\.local\share，或 HOME/.local/share
///      下的 PosixLoom/data。
///
/// 便携目录优先于用户目录：只有便携盘不可写时才落到用户目录。
fn selected_data_root(run_root: &std::path::Path) -> Result<std::path::PathBuf, String> {
    if let Some(value) = std::env::var("POSIXLOOM_DATA_ROOT")
        .ok()
        .filter(|value| !value.is_empty())
    {
        let requested = absolute_path(std::path::PathBuf::from(value))?;
        std::fs::create_dir_all(&requested)
            .map_err(|error| format!("cannot create {}: {error}", requested.display()))?;
        return Ok(requested);
    }
    let portable = run_root.join("data");
    if probe_writable_directory(&portable).is_ok() {
        return Ok(portable);
    }
    let base = std::env::var("LOCALAPPDATA")
        .ok()
        .filter(|value| !value.is_empty())
        .or_else(|| {
            std::env::var("USERPROFILE")
                .ok()
                .filter(|value| !value.is_empty())
                .map(|home| format!("{home}\\.local\\share"))
        })
        .or_else(|| {
            std::env::var("HOME")
                .ok()
                .filter(|value| !value.is_empty())
                .map(|home| format!("{home}/.local/share"))
        })
        .ok_or_else(|| "cannot determine fallback DataRoot".to_string())?;
    let fallback = absolute_path(std::path::PathBuf::from(base))?
        .join("PosixLoom")
        .join("data");
    probe_writable_directory(&fallback)?;
    Ok(fallback)
}

/// 一次运行时选择的结论。
struct SelectedRuntime {
    /// 运行时 ID（同时是 versions/ 下的目录名）。
    id: String,
    /// 运行时根目录（<base>/runtime/versions/<id>）。
    root: std::path::PathBuf,
    /// 是否按 release 规则对待（release 走哈希与模式强校验）。
    release: bool,
    /// 是否为捆绑在 RunRoot 内的运行时（相对 data 侧安装的运行时而言）。
    bundled: bool,
}

/// 解析当前生效的运行时与 DataRoot（runtime/current 指针链探测）。
/// 探测顺序固定：data 根的指针优先（用户安装/更新过的运行时），
/// 其次 RunRoot 自带的捆绑指针（通常是 runtime-dev）。
/// release 判定：data 侧指针指向的任何 ID 一律按 release 对待
/// （运行时更新只会安装 release）；RunRoot 侧仅当 ID 不是 "runtime-dev"
/// 时按 release 对待。指针存在但读取失败或 ID 非法时直接报错，
/// 不做静默降级（fail-closed）。返回 (选中的运行时或 None, DataRoot)。
fn selected_runtime(
    run_root: &std::path::Path,
) -> Result<(Option<SelectedRuntime>, std::path::PathBuf), String> {
    let data_root = selected_data_root(run_root)?;
    for (base, source_release, bundled) in
        [(data_root.as_path(), true, false), (run_root, false, true)]
    {
        let pointer = base.join("runtime").join("current");
        if !pointer.exists() {
            continue;
        }
        let id = std::fs::read_to_string(&pointer)
            .map_err(|error| format!("cannot read {}: {error}", pointer.display()))?
            .trim()
            .to_string();
        if !valid_runtime_id(&id) {
            return Err(format!("invalid runtime id in {}", pointer.display()));
        }
        let release = source_release || id != "runtime-dev";
        return Ok((
            Some(SelectedRuntime {
                id: id.clone(),
                root: base.join("runtime").join("versions").join(id),
                release,
                bundled,
            }),
            data_root.clone(),
        ));
    }
    Ok((None, data_root))
}

/// 探测某基目录下是否存在 mode 为 "release" 的运行时目录
/// （扫描 runtime/versions/*/manifest.json）。
/// versions 目录不存在视为“没有”；其他 IO/解析错误一律上抛--
/// 探测器自身异常不能被吞掉，否则 fail-closed 判定会基于不完整信息做出。
fn release_runtime_present(base: &std::path::Path) -> Result<bool, String> {
    let versions = base.join("runtime").join("versions");
    let entries = match std::fs::read_dir(&versions) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(format!("cannot inspect {}: {error}", versions.display())),
    };
    for entry in entries {
        let entry =
            entry.map_err(|error| format!("cannot inspect {}: {error}", versions.display()))?;
        if !entry
            .file_type()
            .map_err(|error| error.to_string())?
            .is_dir()
        {
            continue;
        }
        let manifest_path = entry.path().join("manifest.json");
        if !manifest_path.exists() {
            continue;
        }
        let manifest: LauncherManifest = serde_json::from_slice(
            &std::fs::read(&manifest_path)
                .map_err(|error| format!("cannot read {}: {error}", manifest_path.display()))?,
        )
        .map_err(|error| format!("invalid {}: {error}", manifest_path.display()))?;
        if manifest.mode.as_deref() == Some("release") {
            return Ok(true);
        }
    }
    Ok(false)
}

/// 探测 runtime/current 指针是否存在且指向 release 运行时
/// （即指针值不是 "runtime-dev"）。指针不存在返回 false；
/// 存在但读取失败或内容非法则报错，而非当作不存在。
fn release_pointer_present(base: &std::path::Path) -> Result<bool, String> {
    let pointer = base.join("runtime").join("current");
    let value = match std::fs::read_to_string(&pointer) {
        Ok(value) => value.trim().to_string(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(format!("cannot read {}: {error}", pointer.display())),
    };
    if !valid_runtime_id(&value) {
        return Err(format!("invalid runtime id in {}", pointer.display()));
    }
    Ok(value != "runtime-dev")
}

/// 判断字符串是否是“安全”的相对路径：非空、非绝对，且所有路径分量
/// 都是普通分量或 "."。这明确排除了 ".."、根、盘符/UNC 前缀等分量，
/// 是所有来自外部数据（清单 entrypoint、SHA256SUMS 条目）的路径
/// 在参与拼接前必须通过的关卡，防止拼出的路径逃逸出预期根目录。
/// 从 release 运行时解析出可用且已验证的 Node 可执行文件路径。
/// 逐条防御：
///   - manifestVersion 必须是 1（未知结构宁可拒绝也不猜测）；
///   - id 为 "node" 的组件必须恰好一个（零个无法启动，多个意味着选择歧义）；
///   - entrypoint 归一化为 '/' 后必须精确等于 node/node[.exe]，
///     且通过 safe_relative_path--禁止清单把入口指到 Runtime 之外；
///   - 组件必须声明 SHA-256 且实算一致（verify_hash 同时排除符号链接）。
///
/// 返回的路径是“此刻内容已验证”的；之后若被替换，下次校验仍会失败。
fn release_node(
    runtime: &SelectedRuntime,
    manifest: &LauncherManifest,
) -> Result<std::path::PathBuf, String> {
    if manifest.manifest_version != Some(1) {
        return Err("release Runtime has an unsupported manifestVersion".to_string());
    }
    let nodes: Vec<&LauncherComponent> = manifest
        .components
        .iter()
        .filter(|component| component.id == "node")
        .collect();
    if nodes.len() != 1 {
        return Err("release Runtime must declare exactly one Node component".to_string());
    }
    let node = nodes[0];
    let normalized = node.entrypoint.replace('\\', "/");
    let expected_entrypoint = if cfg!(windows) {
        "node/node.exe"
    } else {
        "node/node"
    };
    if normalized != expected_entrypoint || !safe_relative_path(&node.entrypoint) {
        return Err(format!(
            "release Runtime Node entrypoint must be {expected_entrypoint}"
        ));
    }
    let candidate = runtime.root.join(&node.entrypoint);
    if !candidate.is_file() {
        return Err("release Runtime is missing its packaged Node executable".to_string());
    }
    let expected_hash = node
        .sha256
        .as_deref()
        .ok_or_else(|| "release Runtime Node component has no SHA-256".to_string())?;
    verify_hash(&candidate, expected_hash, "Node component")?;
    Ok(candidate)
}

/// 校验清单声明的模式与选择侧推断的模式一致：
/// release 位置出现 development 清单（或反之）意味着运行时被降级/伪造，
/// 直接拒绝。典型攻击场景：把“已安装 release 运行时”换成无哈希要求的
/// dev 清单来绕过 node 组件哈希校验。
fn verify_launcher_mode(
    runtime: &SelectedRuntime,
    manifest: &LauncherManifest,
) -> Result<(), String> {
    let expected_mode = if runtime.release {
        "release"
    } else {
        "development"
    };
    if manifest.mode.as_deref() != Some(expected_mode) {
        return Err(format!(
            "selected Runtime must declare {expected_mode} mode"
        ));
    }
    Ok(())
}

/// 给定已选择的运行时，解析出可用的 Node 路径。
/// 统一流程：读 manifest -> runtimeId 必须与目录名一致 -> 模式一致 ->
/// release 走 release_node（含组件哈希），development 直接取 node/node[.exe]。
/// 捆绑在 RunRoot 内的 release 运行时，其 manifest.json 自身也必须先通过
/// SHA256SUMS 校验，防止攻击者改 manifest 里的哈希来“洗白”被篡改的 node。
fn runtime_node_candidate(
    run_root: &std::path::Path,
    runtime: SelectedRuntime,
    package_integrity_required: bool,
) -> Result<std::path::PathBuf, String> {
    let manifest_path = runtime.root.join("manifest.json");
    // 捆绑在 RunRoot 内且要求完整性时，manifest 自身也在 SHA256SUMS 覆盖范围内，
    // 必须先校验再读取其中的哈希声明。
    if runtime.release && runtime.bundled && package_integrity_required {
        let relative_manifest = manifest_path
            .strip_prefix(run_root)
            .map_err(|_| "bundled Runtime manifest escapes RunRoot".to_string())?
            .to_string_lossy()
            .replace('\\', "/");
        verify_package_checksum(run_root, &relative_manifest)?;
    }
    let manifest: LauncherManifest = serde_json::from_slice(
        &std::fs::read(&manifest_path)
            .map_err(|error| format!("cannot read {}: {error}", manifest_path.display()))?,
    )
    .map_err(|error| format!("invalid {}: {error}", manifest_path.display()))?;
    if manifest.runtime_id != runtime.id {
        return Err("Runtime directory does not match manifest runtimeId".to_string());
    }
    verify_launcher_mode(&runtime, &manifest)?;
    if runtime.release {
        return release_node(&runtime, &manifest);
    }
    // development 运行时直接取 node/node[.exe]，无哈希要求（本地开发产物，
    // 只有 release 运行时才承诺供应链完整性）。
    for name in ["node.exe", "node"] {
        let candidate = runtime.root.join("node").join(name);
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    Err("development Runtime has no packaged Node".to_string())
}

/// 读取某基目录的 runtime/current 指针并构造 SelectedRuntime。
/// 指针不存在返回 None（未选择运行时）；存在但读取失败或 ID 非法则报错，
/// 不静默忽略。release 判定：data 侧（非捆绑）一律按 release；
/// RunRoot 侧（捆绑）仅当 ID 不是 "runtime-dev" 时按 release。
fn runtime_from_pointer(
    base: &std::path::Path,
    bundled: bool,
) -> Result<Option<SelectedRuntime>, String> {
    let pointer = base.join("runtime").join("current");
    let id = match std::fs::read_to_string(&pointer) {
        Ok(value) => value.trim().to_string(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("cannot read {}: {error}", pointer.display())),
    };
    if !valid_runtime_id(&id) {
        return Err(format!("invalid runtime id in {}", pointer.display()));
    }
    Ok(Some(SelectedRuntime {
        release: !bundled || id != "runtime-dev",
        root: base.join("runtime").join("versions").join(&id),
        id,
        bundled,
    }))
}

/// 恢复模式专用：在一个基目录下尽力找到一个能通过全部校验的 Node。
/// 策略（优先级递降）：
///   1. 指针指向的运行时，若能完整通过校验则直接用；
///   2. 否则枚举 runtime/versions/ 下所有目录，按名称降序（最新优先）
///      逐个尝试能通过 manifest/runtimeId/模式/哈希校验的运行时；
///   3. 都不行返回 None，由调用方决定后续。
///
/// 这里的失败被静默跳过--恢复模式的目标是“尽力拉起”，但每一个最终
/// 被选中的候选仍然必须通过全部校验，放宽的只是“指针必须有效”这一条。
fn recovery_node_from_base(
    run_root: &std::path::Path,
    base: &std::path::Path,
    bundled: bool,
    package_integrity_required: bool,
) -> Option<std::path::PathBuf> {
    if let Ok(Some(runtime)) = runtime_from_pointer(base, bundled) {
        if let Ok(node) = runtime_node_candidate(run_root, runtime, package_integrity_required) {
            return Some(node);
        }
    }
    let versions = base.join("runtime").join("versions");
    let mut entries: Vec<_> = std::fs::read_dir(versions)
        .ok()?
        .filter_map(Result::ok)
        .collect();
    // 版本名降序排列：优先尝试最新版本；坏掉的指针往往指向次新的可用版本。
    entries.sort_by_key(|entry| entry.file_name());
    entries.reverse();
    for entry in entries {
        if !entry
            .file_type()
            .map(|file_type| file_type.is_dir())
            .unwrap_or(false)
        {
            continue;
        }
        let id = entry.file_name().to_string_lossy().into_owned();
        if !valid_runtime_id(&id) {
            continue;
        }
        let manifest_path = entry.path().join("manifest.json");
        let manifest: LauncherManifest = match std::fs::read(&manifest_path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        {
            Some(manifest) => manifest,
            None => continue,
        };
        if manifest.runtime_id != id {
            continue;
        }
        let runtime = SelectedRuntime {
            release: manifest.mode.as_deref() == Some("release"),
            id,
            root: entry.path(),
            bundled,
        };
        if let Ok(node) = runtime_node_candidate(run_root, runtime, package_integrity_required) {
            return Some(node);
        }
    }
    None
}

/// 只有 RunRoot 明确指向一个结构有效的 development Runtime 时，恢复命令才可
/// 在捆绑 Node 缺失后使用开发机上的 Node。SHA256SUMS 仍负责校验应用代码；这里
/// 只区分“带完整性清单的开发包”和必须坚持捆绑 Node 的 release 包。
fn bundled_development_fallback_allowed(run_root: &std::path::Path) -> Result<bool, String> {
    if release_pointer_present(run_root)? || release_runtime_present(run_root)? {
        return Ok(false);
    }
    let Some(runtime) = runtime_from_pointer(run_root, true)? else {
        return Ok(false);
    };
    if runtime.release {
        return Ok(false);
    }
    let manifest_path = runtime.root.join("manifest.json");
    if run_root.join("SHA256SUMS").is_file() {
        verify_package_checksum(run_root, "runtime/current")?;
        let relative_manifest = manifest_path
            .strip_prefix(run_root)
            .map_err(|_| "bundled development Runtime manifest escapes RunRoot".to_string())?
            .to_string_lossy()
            .replace('\\', "/");
        verify_package_checksum(run_root, &relative_manifest)?;
    }
    let manifest: LauncherManifest = serde_json::from_slice(
        &std::fs::read(&manifest_path)
            .map_err(|error| format!("cannot read {}: {error}", manifest_path.display()))?,
    )
    .map_err(|error| format!("invalid {}: {error}", manifest_path.display()))?;
    if manifest.runtime_id != runtime.id {
        return Err("runtime/current does not match manifest runtimeId".to_string());
    }
    verify_launcher_mode(&runtime, &manifest)?;
    Ok(true)
}

/// 恢复模式（runtime doctor/update/rollback）的 Node 选择入口。
/// 与正常路径 select_launcher_node 的差异只在“如何挑运行时”：
///   - 完整性要求（SHA256SUMS 存在 / release 指针 / release 运行时目录）
///     仍然全额执行--恢复操作本身不能运行被篡改的应用包；
///   - Node 候选放宽为：先捆绑 RunRoot、再 data 根，各自按
///     recovery_node_from_base 的降级枚举策略尽力找一个通过校验的运行时；
///   - 仍找不到时：release 包直接失败；明确的 development Runtime 则与普通
///     启动路径一致，允许 POSIXLOOM_NODE 或 PATH 上的 node。
fn select_recovery_launcher_node(root: &std::path::Path) -> Result<String, String> {
    let root_path = absolute_path(root.to_path_buf())?;
    let data_root = selected_data_root(&root_path)?;
    // 完整性判定与正常路径同一套三信号：任一成立即强制整包校验。
    let package_integrity_required = root_path.join("SHA256SUMS").exists()
        || release_pointer_present(&root_path)?
        || release_runtime_present(&root_path)?;
    if package_integrity_required {
        verify_package_application(&root_path)?;
    }
    // 捆绑运行时（RunRoot 内）优先，data 侧安装的运行时次之；
    // 两者都按放宽策略“尽力找一个通过校验的 Node”。
    if let Some(node) =
        recovery_node_from_base(&root_path, &root_path, true, package_integrity_required).or_else(
            || recovery_node_from_base(&root_path, &data_root, false, package_integrity_required),
        )
    {
        return Ok(node.to_string_lossy().into_owned());
    }
    // SHA256SUMS 要求应用代码通过校验，但 development 包按定义允许缺少第三方
    // 组件。仅当 RunRoot 明确指向有效的 runtime-dev 时放行外部 Node；release
    // 包、指针缺失或清单损坏仍然 fail-closed。
    let development_fallback_allowed = bundled_development_fallback_allowed(&root_path)?;
    if package_integrity_required && !development_fallback_allowed {
        return Err(
            "no validated bundled or previous Runtime Node is available for recovery".to_string(),
        );
    }
    // 纯开发布局以及已校验应用代码的 development 包都可使用显式/系统 Node。
    if let Ok(node) = std::env::var("POSIXLOOM_NODE") {
        if std::path::Path::new(&node).is_file() {
            return Ok(node);
        }
    }
    Ok("node".to_string())
}

/// 正常（非恢复）路径的 Node 选择入口，全流程 fail-closed：
///   1. 解析指针链得到当前运行时（data 优先于捆绑）；
///   2. 判定是否强制应用包完整性（SHA256SUMS / release 指针 / release
///      运行时目录任一成立），成立则先整包校验；
///   3. 有指针：读 manifest，校验 runtimeId 与模式；release 还要校验
///      （捆绑时含 manifest 自身的清单哈希）与 node 组件哈希，
///      development 直接取 node/node[.exe]；
///   4. 无指针但检测到 release 运行时：说明指针丢失/被删，状态损坏，
///      直接拒绝--绝不回退 PATH 上的 node，防止环境注入的解释器
///      绕过一切完整性校验接管启动；
///   5. 开发布局（无 release 痕迹且无指针）才允许 POSIXLOOM_NODE / PATH 的 node。
fn select_launcher_node(root: &str) -> Result<String, String> {
    let root_path = absolute_path(std::path::PathBuf::from(root))?;
    let (selected, data_root) = selected_runtime(&root_path)?;
    // 完整性判定三信号：SHA256SUMS 在场、指针指向 release、
    // 或 versions/ 下存在 release 运行时。任一成立即启用强制校验。
    let package_integrity_required = root_path.join("SHA256SUMS").exists()
        || release_pointer_present(&root_path)?
        || release_runtime_present(&root_path)?;
    if package_integrity_required {
        verify_package_application(&root_path)?;
    }
    // 有指针：解析 manifest 并逐项校验；捆绑的 release 运行时还要先校验
    // manifest 自身的 SHA256SUMS 记录（防止改 manifest 哈希来洗白 node）。
    if let Some(runtime) = selected {
        let manifest_path = runtime.root.join("manifest.json");
        if runtime.release && runtime.bundled {
            let relative_manifest = manifest_path
                .strip_prefix(&root_path)
                .map_err(|_| "bundled Runtime manifest escapes RunRoot".to_string())?
                .to_string_lossy()
                .replace('\\', "/");
            verify_package_checksum(&root_path, &relative_manifest)?;
        }
        let manifest: LauncherManifest = serde_json::from_slice(
            &std::fs::read(&manifest_path)
                .map_err(|error| format!("cannot read {}: {error}", manifest_path.display()))?,
        )
        .map_err(|error| format!("invalid {}: {error}", manifest_path.display()))?;
        if manifest.runtime_id != runtime.id {
            return Err("runtime/current does not match manifest runtimeId".to_string());
        }
        verify_launcher_mode(&runtime, &manifest)?;
        if runtime.release {
            return Ok(release_node(&runtime, &manifest)?
                .to_string_lossy()
                .into_owned());
        }
        // development 运行时：直接取 node/node[.exe]，无哈希要求。
        for name in ["node.exe", "node"] {
            let candidate = runtime.root.join("node").join(name);
            if candidate.exists() {
                return Ok(candidate.to_string_lossy().into_owned());
            }
        }
    } else {
        // 关键 fail-closed 点：无指针时仍要检查两个基目录有没有 release 运行时。
        // 有则说明指针丢失/被删（状态损坏），拒绝启动而不是回退 PATH--
        // 否则环境里任何 node 都能绕过全部校验接管启动流程。
        if [&data_root, &root_path]
            .iter()
            .map(|base| release_runtime_present(base))
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .any(|present| present)
        {
            return Err(
                "release Runtime pointer is missing; refusing PATH Node fallback".to_string(),
            );
        }
    }
    // 开发布局兜底：显式 POSIXLOOM_NODE 优先于 PATH 上的 node。
    if let Ok(node) = std::env::var("POSIXLOOM_NODE") {
        if std::path::Path::new(&node).exists() {
            return Ok(node);
        }
    }
    Ok("node".to_string())
}

#[cfg(test)]
mod tests;
