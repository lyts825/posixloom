use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::io::Read;

pub(super) fn safe_relative_path(value: &str) -> bool {
    let path = std::path::Path::new(value);
    !value.is_empty()
        && !path.is_absolute()
        && path.components().all(|component| {
            matches!(
                component,
                std::path::Component::Normal(_) | std::path::Component::CurDir
            )
        })
}

/// 以 64KB 块流式计算文件的 SHA-256，返回十六进制小写字符串。
/// 流式而非一次读入，避免对大文件（如 node.exe）做整文件内存映射。
pub(super) fn sha256_file(path: &std::path::Path) -> Result<String, String> {
    let mut file = std::fs::File::open(path)
        .map_err(|error| format!("cannot read {}: {error}", path.display()))?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let size = file
            .read(&mut buffer)
            .map_err(|error| format!("cannot read {}: {error}", path.display()))?;
        if size == 0 {
            break;
        }
        hash.update(&buffer[..size]);
    }
    Ok(hash
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

/// 校验单个文件与清单期望的 SHA-256 一致，三段防御：
///   1. 期望值本身必须是 64 位十六进制（防清单塞入畸形值绕过比较）；
///   2. 目标必须是真实普通文件且不是符号链接。用 symlink_metadata
///      （不跟随链接）做判定，防止“校验的是 A、实际执行的是 B”的
///      链接替换攻击；
///   3. 实算哈希与期望值（统一转小写后）精确比较。
///
/// 任一环节失败都返回带 label 的错误信息。
pub(super) fn verify_hash(
    path: &std::path::Path,
    expected: &str,
    label: &str,
) -> Result<(), String> {
    if expected.len() != 64 || !expected.chars().all(|ch| ch.is_ascii_hexdigit()) {
        return Err(format!("{label} has an invalid SHA-256 value"));
    }
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|error| format!("cannot inspect {}: {error}", path.display()))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(format!("{label} must be a real file, not a link"));
    }
    let actual = sha256_file(path)?;
    if actual != expected.to_ascii_lowercase() {
        return Err(format!(
            "{label} SHA-256 mismatch (expected {expected}, actual {actual})"
        ));
    }
    Ok(())
}

/// 解析并严格校验 RunRoot 下的 SHA256SUMS 清单，返回 (相对路径, 小写哈希) 列表。
/// 清单自身必须是真实文件而非符号链接。逐行校验规则（任一不满足整体拒绝）：
///   - 行格式必须是 "<64 位十六进制哈希><两个空格><路径>"（GNU sha256sum 格式）；
///   - 路径不允许反斜杠、冒号（盘符/备用数据流语法）、NUL，
///     也不允许空段或 "."/".." 段（杜绝 Windows 路径遍历）；
///   - 不允许条目指向 SHA256SUMS 自身（清单不能校验自己）；
///   - 路径按小写去重（NTFS 大小写不敏感，重复条目会造成覆盖歧义）；
///   - 清单为空视为损坏。
pub(super) fn package_checksum_records(
    run_root: &std::path::Path,
) -> Result<Vec<(String, String)>, String> {
    let sums_path = run_root.join("SHA256SUMS");
    let sums_metadata = std::fs::symlink_metadata(&sums_path)
        .map_err(|error| format!("cannot inspect {}: {error}", sums_path.display()))?;
    if !sums_metadata.is_file() || sums_metadata.file_type().is_symlink() {
        return Err("SHA256SUMS must be a real file, not a link".to_string());
    }
    let sums = std::fs::read_to_string(&sums_path)
        .map_err(|error| format!("cannot read {}: {error}", sums_path.display()))?;
    let mut seen = BTreeSet::new();
    let mut records = Vec::new();
    for (index, line) in sums.lines().enumerate() {
        let (hash, path) = line
            .split_once("  ")
            .ok_or_else(|| format!("invalid SHA256SUMS line {}", index + 1))?;
        if hash.len() != 64 || !hash.chars().all(|ch| ch.is_ascii_hexdigit()) {
            return Err(format!("invalid SHA256SUMS digest on line {}", index + 1));
        }
        // 路径白名单化：拒绝一切能让条目脱离 RunRoot 或指向清单自身的语法。
        if path.is_empty()
            || path.chars().any(|ch| matches!(ch, '\\' | ':' | '\0'))
            || path
                .split('/')
                .any(|segment| segment.is_empty() || matches!(segment, "." | ".."))
            || path.eq_ignore_ascii_case("SHA256SUMS")
        {
            return Err(format!("unsafe SHA256SUMS path on line {}", index + 1));
        }
        if !seen.insert(path.to_lowercase()) {
            return Err(format!("duplicate SHA256SUMS path: {path}"));
        }
        records.push((path.to_string(), hash.to_ascii_lowercase()));
    }
    if records.is_empty() {
        return Err("SHA256SUMS contains no package records".to_string());
    }
    Ok(records)
}

/// 校验 RunRoot 下某个包内文件与 SHA256SUMS 一致：
/// 先确认目标路径本身是安全相对路径（防逃逸），再要求清单中恰好存在
/// 一条与之匹配的记录（“恰好一条”排除大小写变体重复造成的歧义），
/// 最后做哈希比对。捆绑运行时的 manifest.json 就是通过它逐文件校验的。
pub(super) fn verify_package_checksum(
    run_root: &std::path::Path,
    relative: &str,
) -> Result<(), String> {
    if !safe_relative_path(relative) {
        return Err(format!("unsafe package checksum path: {relative}"));
    }
    let records = package_checksum_records(run_root)?;
    let matches: Vec<&String> = records
        .iter()
        .filter_map(|(path, hash)| path.eq_ignore_ascii_case(relative).then_some(hash))
        .collect();
    if matches.len() != 1 {
        return Err(format!(
            "SHA256SUMS must contain exactly one entry for {relative}"
        ));
    }
    verify_hash(&run_root.join(relative), matches[0], relative)
}

/// 递归收集 config/ 与 dist/ 下的真实文件清单（相对 RunRoot、'/' 分隔）。
/// 遍历本身就是完整性检查：目录或文件是符号链接、出现既非文件又非目录的
/// 条目、或路径无法映射回 RunRoot（逃逸）都立即报错。
/// 结果用于稍后与 SHA256SUMS 做“精确覆盖”双向比对。
pub(super) fn collect_real_package_files(
    run_root: &std::path::Path,
    directory: &std::path::Path,
    files: &mut Vec<String>,
) -> Result<(), String> {
    let directory_metadata = std::fs::symlink_metadata(directory)
        .map_err(|error| format!("cannot inspect {}: {error}", directory.display()))?;
    if !directory_metadata.is_dir() || directory_metadata.file_type().is_symlink() {
        return Err(format!(
            "package application directory must be a real directory: {}",
            directory.display()
        ));
    }
    for entry in std::fs::read_dir(directory)
        .map_err(|error| format!("cannot inspect {}: {error}", directory.display()))?
    {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        let metadata = std::fs::symlink_metadata(&path)
            .map_err(|error| format!("cannot inspect {}: {error}", path.display()))?;
        if metadata.file_type().is_symlink() {
            return Err(format!(
                "package application cannot contain a link: {}",
                path.display()
            ));
        }
        if metadata.is_dir() {
            collect_real_package_files(run_root, &path, files)?;
        } else if metadata.is_file() {
            let relative = path
                .strip_prefix(run_root)
                .map_err(|_| {
                    format!(
                        "package application file escapes RunRoot: {}",
                        path.display()
                    )
                })?
                .to_string_lossy()
                .replace('\\', "/");
            files.push(relative);
        } else {
            return Err(format!(
                "package application contains an unsupported file: {}",
                path.display()
            ));
        }
    }
    Ok(())
}

/// 应用包完整性校验的主入口（必须在信任 Node 之前调用）。三层保证：
///   1. 清单中属于应用包的记录（package.json 与 config/、dist/ 前缀）
///      逐条做哈希校验，且 package.json、config/defaults.json、
///      dist/src/cli/main.js 三个启动必需文件必须在场；
///   2. 递归实扫 config/ 与 dist/，要求与清单记录精确互相覆盖：
///      磁盘上多出的文件（未被清单覆盖）与清单里多出的记录都算失败--
///      “精确覆盖”确保没有文件能躲在清单之外被加载，也没有死记录掩盖缺文件；
///   3. 扫描本身排除符号链接与逃逸路径（见 collect_real_package_files）。
///
/// 换言之：对 dist/config 的任何篡改、增删都会让启动在此失败。
pub(super) fn verify_package_application(run_root: &std::path::Path) -> Result<(), String> {
    let records = package_checksum_records(run_root)?;
    // 启动必需的三个应用文件：缺失任何一个 CLI 都无法运行，提前给出明确错误。
    let mut required = BTreeSet::from([
        "package.json".to_string(),
        "config/defaults.json".to_string(),
        "dist/src/cli/main.js".to_string(),
    ]);
    let mut application_records = BTreeSet::new();
    // 只校验属于应用包的记录（package.json 与 config/、dist/ 前缀）；
    // 其余记录（例如捆绑运行时的 manifest.json）由各自路径单独校验。
    for (path, hash) in records {
        let normalized = path.to_ascii_lowercase();
        if path.eq_ignore_ascii_case("package.json")
            || normalized.starts_with("config/")
            || normalized.starts_with("dist/")
        {
            verify_hash(&run_root.join(&path), &hash, &path)?;
            required.retain(|entry| !entry.eq_ignore_ascii_case(&path));
            application_records.insert(path.to_lowercase());
        }
    }
    if application_records.is_empty() || !required.is_empty() {
        return Err(format!(
            "SHA256SUMS is missing required application files: {}",
            required.into_iter().collect::<Vec<_>>().join(", ")
        ));
    }
    // 实际扫描磁盘：config/ 与 dist/ 的真实文件集合（package.json 上面已校验过）。
    let mut application_files = vec!["package.json".to_string()];
    collect_real_package_files(run_root, &run_root.join("config"), &mut application_files)?;
    collect_real_package_files(run_root, &run_root.join("dist"), &mut application_files)?;
    let actual: BTreeSet<String> = application_files
        .into_iter()
        .map(|path| path.to_lowercase())
        .collect();
    // 双向精确覆盖：磁盘上多出清单没有的文件（uncovered 非空），
    // 或清单记录数与实际文件数不一致（清单里有磁盘上不存在的记录），都算失败。
    let uncovered: Vec<&String> = actual.difference(&application_records).collect();
    if !uncovered.is_empty() || actual.len() != application_records.len() {
        return Err(format!(
            "SHA256SUMS does not exactly cover package application files{}",
            uncovered
                .first()
                .map(|path| format!(": {path}"))
                .unwrap_or_default()
        ));
    }
    Ok(())
}
