# ComfyUI-WorkFlow-DRM(Digital Rights Management)

一个面向 ComfyUI 的工作流保护插件，用于把选中的节点打包为黑盒节点，并支持离线授权、到期控制与防时间回拨。

## 项目背景

在实际商用场景中，ComfyUI 工作流常常包含以下高价值资产：

- Prompt 工程细节
- 参数与调度策略
- 自定义节点组合逻辑
- 商业化素材生产流程

本项目的目标是：在尽量不改动 ComfyUI 核心源码的前提下，实现“可交付、可控、可授权”的工作流分发方案，兼顾开发便利性与运行安全性。

## 核心能力

- 前端框选节点后打包为 `DRM_BlackBox_Node`
- 黑盒内部子图可执行，不直接暴露完整流程
- AES-GCM 加密存储子图
- 双轨解密
  - 开发者模式：Password
  - 授权模式：License + 机器码 + RSA 验签
- 防时间回拨（本地审计时间戳）
- Cython 编译核心（`.pyd/.so`）并支持 Python 回退导入

## 目录结构

```text
ComfyUI-WorkFlow-DRM/
├─ __init__.py
├─ node.py
├─ drm_core.py
├─ setup.py
├─ requirements.txt
├─ generate_license.py
├─ generate_license_gui.py
├─ release_bundle.py
├─ 打开签发GUI.bat
├─ 生成RSA密钥对.bat
├─ 一键发布.bat
├─ public_key.pem
└─ web/
   └─ drm_blackbox.js
```

## 安装说明

### 1) 复制插件目录

将项目目录放入：

```text
ComfyUI/custom_nodes/
```

### 2) 安装依赖

在 ComfyUI Python 环境执行：

```bash
pip install -r requirements.txt
```

### 3) 重启 ComfyUI

重启后在画布右键菜单可看到“打包为黑盒”。

## 快速使用

### A. 开发者打包黑盒

1. 在画布框选目标节点
2. 在画布空白处右键选择“打包为黑盒”
3. 输入 Password
4. 自动替换成 `DRM_BlackBox_Node` 并保留外部连线

### B. 开发者还原黑盒

1. 右键黑盒节点
2. 选择“输入密码还原黑盒”
3. 输入 Password 后恢复原始节点

### C. 授权客户使用（离线）

1. 客户机器上右键黑盒节点，选择“显示本机机器码”
2. 你用私钥签发 License
3. 客户在 `license_code` 填入 License，即可执行

## 签发 License（CLI）

```bash
python generate_license.py ^
  --blackbox-json-file 工作流json文件路径 ^
  --blackbox-node-id 黑盒编号（一个可不填） ^
  --password 你的开发密码 ^
  --private-key-file private_key.pem ^
  --machine-code 客户机器码 ^
  --expire-date 2026-12-30 ^
  --output-file license.txt
```

参数说明：

- `--blackbox-json-file`：支持完整工作流 JSON 或纯密文 JSON
- `--blackbox-node-id`：同一工作流有多个黑盒节点时指定
- `--password`：打包黑盒时设置的密码
- `--private-key-file`：签发私钥路径
- `--machine-code`：目标设备机器码
- `--expire-date`：到期日期，格式 `YYYY-MM-DD`
- `--output-file`：输出授权码文件

## 签发 License（GUI）

运行：

```bash
python generate_license_gui.py
```

或者直接双击：

- `打开签发GUI.bat`

GUI 本质上复用 CLI 核心函数，不改变原签发逻辑。

## 密钥生成

可双击运行：

- `生成RSA密钥对.bat`

会生成：

- `private_key.pem`（只留在签发机，绝不分发）
- `public_key.pem`（随插件分发给客户验签）

## Cython 编译与导入兼容

编译命令：

```bash
python setup.py build_ext --inplace
```

产物：

- Windows：`drm_core_ext*.pyd`
- Linux/macOS：`drm_core_ext*.so`

导入策略（在 `node.py` 中）：

1. 优先加载编译扩展 `drm_core_ext`
2. 失败则回退加载 Python 源码 `drm_core.py`

## 发布打包

### 一键发布（推荐）

双击：

- `一键发布.bat`

流程：

1. 编译核心扩展
2. 生成 binary 发布目录
3. 自动打开发布目录

### 脚本化发布

```bash
python release_bundle.py --mode binary --clean
```

可选模式：

- `binary`：闭源分发（`.pyd/.so`）
- `open`：源码分发（`drm_core.py`）

输出包含：

- `dist/LockNodes_release_<mode>/`
- `RELEASE_MANIFEST.json`（文件列表+SHA256）

## 免责声明

本项目用于工作流授权控制与知识产权保护。请确保你的使用符合所在地区法律法规与合同约定。
