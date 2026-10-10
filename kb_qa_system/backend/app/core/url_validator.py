"""
URL 安全校验模块（SSRF 防护）

作用：
    对外部 URL 进行安全校验，防止 SSRF（Server-Side Request Forgery）攻击。
    SSRF 攻击者可诱导服务器访问内网资源（如元数据服务、内部 API、数据库等），
    造成敏感信息泄露或内网渗透。

    本模块在 HTTP 请求发出前拦截危险 URL，是 SSRF 防御的第一道防线。

实现方式：
    1. 解析 URL，只允许 http/https 协议
    2. 解析域名，获取实际 IP 地址（DNS 解析）
    3. 检查 IP 是否属于内网/保留地址段（RFC 1918、环回、链路本地等）
    4. 阻止访问云元数据服务（169.254.169.254）
    5. 限制重定向跟随（由调用方控制，此处仅校验初始 URL）

安全策略：
    - 协议白名单：仅 http、https
    - IP 黑名单：私有地址、环回、链路本地、多播、保留地址
    - 端口黑名单：22(SSH)、25(SMTP)、3306(MySQL)、5432(PostgreSQL)、6379(Redis)、9200(ES) 等
    - 域名黑名单：localhost、metadata.google.internal、169.254.169.254 等

使用方式：
    from app.core.url_validator import validate_url, URLValidationError

    try:
        validate_url("https://example.com/article")
    except URLValidationError as e:
        # 拒绝非安全 URL
        raise HTTPException(400, detail=str(e))
"""

import socket
import ipaddress
import logging
import re
import html
from urllib.parse import urlparse

logger = logging.getLogger(__name__)


# ============================================
# 自定义异常
# ============================================

class URLValidationError(Exception):
    """
    URL 校验失败异常

    作用：
        当 URL 不符合安全要求时抛出，携带具体的错误原因。
        调用方应捕获此异常并返回 400 错误给客户端。
    """
    pass


# ============================================
# 安全配置
# ============================================

# 允许的协议白名单
# 作用：只允许 http 和 https，禁止 file://、ftp://、gopher:// 等危险协议
ALLOWED_SCHEMES = frozenset({"http", "https"})

# 禁止访问的端口黑名单
# 作用：防止通过 URL 访问内部服务（数据库、缓存、消息队列等）
BLOCKED_PORTS = frozenset({
    22,    # SSH
    23,    # Telnet
    25,    # SMTP
    110,   # POP3
    143,   # IMAP
    389,   # LDAP
    636,   # LDAPS
    993,   # IMAPS
    995,   # POP3S
    1433,  # SQL Server
    1521,  # Oracle
    3306,  # MySQL
    5432,  # PostgreSQL
    6379,  # Redis
    9200,  # Elasticsearch
    9300,  # Elasticsearch
    11211, # Memcached
    27017, # MongoDB
    50070, # Hadoop NameNode
})

# 禁止访问的域名黑名单
# 作用：防止访问云平台元数据服务和本地特殊域名
BLOCKED_HOSTNAMES = frozenset({
    "localhost",
    "metadata.google.internal",       # GCP 元数据服务
    "metadata.aws.internal",          # AWS 元数据服务（兼容）
    "169.254.169.254",                # AWS/Azure 元数据服务 IP
    "metadata.azure.com",             # Azure 元数据服务
    "0.0.0.0",
    "::1",
    "[::1]",
})

# URL 最大长度限制
# 作用：防止超长 URL 导致的缓冲区溢出或日志注入
MAX_URL_LENGTH = 2048


# ============================================
# 核心校验函数
# ============================================

def validate_url(url: str, allow_private: bool = False) -> str:
    """
    校验 URL 安全性（SSRF 防护核心函数）

    作用：
        对外部 URL 进行多层安全校验，阻止 SSRF 攻击。
        校验通过则返回规范化后的 URL，否则抛出 URLValidationError。

    实现方式：
        1. 基础校验：非空、长度、协议白名单
        2. 域名校验：黑名单、格式合法性
        3. 端口校验：黑名单端口
        4. IP 解析：DNS 解析域名获取实际 IP
        5. IP 校验：私有/保留/环回/链路本地地址检测

    参数：
        url: str - 待校验的 URL 字符串
        allow_private: bool - 是否允许私有地址（默认 False）
            False：拒绝所有内网地址（生产环境推荐）
            True：允许私有地址（仅开发/测试环境使用）

    返回:
        str - 校验通过后的规范化 URL

    异常:
        URLValidationError - URL 不符合安全要求时抛出

    使用示例:
        >>> validate_url("https://example.com/article")
        'https://example.com/article'

        >>> validate_url("http://127.0.0.1:8080/admin")
        URLValidationError: 禁止访问内网地址 127.0.0.1
    """
    if not url or not isinstance(url, str):
        raise URLValidationError("URL 不能为空")

    url = url.strip()

    # 1. 长度校验
    # 作用：防止超长 URL 导致缓冲区溢出或日志注入
    if len(url) > MAX_URL_LENGTH:
        raise URLValidationError(f"URL 长度超过限制（最大 {MAX_URL_LENGTH} 字符）")

    # 2. 解析 URL
    try:
        parsed = urlparse(url)
    except Exception as e:
        raise URLValidationError(f"URL 格式无效: {e}")

    # 3. 协议校验（白名单）
    # 作用：只允许 http/https，阻止 file://、ftp://、gopher:// 等
    scheme = (parsed.scheme or "").lower()
    if scheme not in ALLOWED_SCHEMES:
        raise URLValidationError(
            f"不允许的协议 '{scheme}'，仅支持 http/https"
        )

    # 4. 域名/主机校验
    hostname = (parsed.hostname or "").lower()
    if not hostname:
        raise URLValidationError("URL 缺少主机名")

    # 4.1 域名黑名单检查
    # 作用：阻止访问已知的元数据服务和特殊域名
    if hostname in BLOCKED_HOSTNAMES:
        raise URLValidationError(f"禁止访问的域名: {hostname}")

    # 5. 端口校验
    # 作用：阻止通过 URL 访问数据库、缓存等内部服务端口
    try:
        port = parsed.port
    except ValueError:
        raise URLValidationError("URL 端口无效") from None
    if parsed.username is not None or parsed.password is not None or any(ord(c) < 33 for c in url):
        raise URLValidationError("URL 不得包含凭据或控制字符")
    if port is not None and port in BLOCKED_PORTS:
        raise URLValidationError(f"禁止访问的端口: {port}")

    # 6. IP 地址校验（SSRF 防护核心）
    # 作用：解析域名获取实际 IP，检查是否为内网/保留地址
    _validate_hostname_ip(hostname, allow_private)

    return url


def _validate_hostname_ip(hostname: str, allow_private: bool) -> list[str]:
    """
    校验主机名对应的 IP 是否安全

    作用：
        将域名解析为 IP 地址，检查 IP 是否属于内网/保留地址段。
        这是 SSRF 防护的核心——即使域名看起来正常，其解析的 IP 可能是内网地址。

    实现方式：
        1. 如果 hostname 本身是 IP，直接校验
        2. 如果是域名，通过 socket.getaddrinfo 解析所有 A/AAAA 记录
        3. 逐一检查每个 IP 是否属于禁止的地址段

    参数：
        hostname: str - 主机名或 IP 字符串
        allow_private: bool - 是否允许私有地址

    异常:
        URLValidationError - IP 属于禁止的地址段时抛出
    """
    # 尝试直接解析为 IP（hostname 本身就是 IP 的情况）
    ips_to_check = []

    try:
        # 尝试将 hostname 解析为 IP 地址
        ip = ipaddress.ip_address(hostname)
        ips_to_check.append(ip)
    except ValueError:
        # hostname 是域名，需要 DNS 解析
        try:
            # getaddrinfo 返回所有解析结果（包括 IPv4 和 IPv6）
            # 作用：防止 DNS rebinding，需检查所有解析结果
            addr_infos = socket.getaddrinfo(
                hostname, None, socket.AF_UNSPEC, socket.SOCK_STREAM
            )
            for addr_info in addr_infos:
                ip_str = addr_info[4][0]
                try:
                    ip = ipaddress.ip_address(ip_str)
                    if ip not in ips_to_check:
                        ips_to_check.append(ip)
                except ValueError:
                    continue
        except socket.gaierror as e:
            raise URLValidationError(f"无法解析域名 '{hostname}': {e}")

    if not ips_to_check:
        raise URLValidationError(f"无法解析主机名 '{hostname}' 的 IP 地址")

    # 检查每个 IP 是否属于禁止的地址段
    for ip in ips_to_check:
        _check_ip_safety(ip, hostname, allow_private)
        if not allow_private and not ip.is_global:
            raise URLValidationError("禁止访问非公网地址")
    return [str(ip) for ip in ips_to_check]


def _check_ip_safety(
    ip: ipaddress._BaseAddress,
    hostname: str,
    allow_private: bool,
) -> None:
    """
    检查单个 IP 地址是否安全

    作用：
        判断 IP 是否属于内网、环回、链路本地、多播、保留等危险地址段。
        任一检查命中则抛出异常。

    实现方式：
        使用 ipaddress 模块的内置属性判断地址类型：
        - is_loopback: 127.0.0.0/8、::1
        - is_private: RFC 1918 私有地址（10.x、172.16-31.x、192.168.x）、fc00::/7
        - is_link_local: 169.254.0.0/16（含云元数据服务 169.254.169.254）
        - is_multicast: 224.0.0.0/4、ff00::/8
        - is_reserved: 0.0.0.0/8、240.0.0.0/4 等保留地址
        - is_unspecified: 0.0.0.0、::

    参数：
        ip: ipaddress._BaseAddress - 待检查的 IP 地址对象
        hostname: str - 原始主机名（用于错误信息）
        allow_private: bool - 是否允许私有地址

    异常:
        URLValidationError - IP 属于禁止的地址段时抛出
    """
    # 环回地址（127.0.0.1、::1）
    # 作用：防止访问本机服务
    if ip.is_loopback:
        raise URLValidationError(
            f"禁止访问环回地址 {ip}（hostname={hostname}）"
        )

    # 链路本地地址（169.254.x.x）
    # 作用：防止访问云元数据服务（AWS/GCP/Azure 的 169.254.169.254）
    if ip.is_link_local:
        raise URLValidationError(
            f"禁止访问链路本地地址 {ip}（可能是云元数据服务）"
        )

    # 多播地址
    # 作用：防止通过多播地址触发网络扫描
    if ip.is_multicast:
        raise URLValidationError(f"禁止访问多播地址 {ip}")

    # 保留地址（0.0.0.0、240.x.x.x 等）
    if ip.is_unspecified or ip.is_reserved:
        raise URLValidationError(f"禁止访问保留地址 {ip}")

    # 私有地址（RFC 1918：10.x、172.16-31.x、192.168.x）
    # 作用：防止访问内网服务
    if ip.is_private and not allow_private:
        raise URLValidationError(
            f"禁止访问内网地址 {ip}（hostname={hostname}）。"
            f"如需在开发环境允许，请设置 allow_private=True"
        )


# ============================================
# 文件名安全处理
# ============================================

def sanitize_filename(filename: str, max_length: int = 100) -> str:
    """
    清洗上传文件名，防止路径遍历攻击

    作用：
        对用户上传的文件名进行安全处理，防止：
        1. 路径遍历攻击（../../../etc/passwd）
        2. Windows 路径注入（..\\..\\system32）
        3. 空字节注入（file.txt%00.exe）
        4. 特殊字符导致的文件系统异常
        5. 超长文件名导致的缓冲区溢出

    实现方式：
        1. 取 basename（剥离所有路径前缀）
        2. 替换路径分隔符为下划线
        3. 移除控制字符和空字节
        4. 限制文件名长度
        5. 处理边缘情况（空、全点、保留名）

    参数：
        filename: str - 原始文件名
        max_length: int - 文件名最大长度（默认 100）

    返回:
        str - 清洗后的安全文件名

    使用示例:
        >>> sanitize_filename("../../../etc/passwd")
        'etc_passwd'

        >>> sanitize_filename("report.pdf")
        'report.pdf'

        >>> sanitize_filename("")
        'unnamed'
    """
    if not filename or not isinstance(filename, str):
        return "unnamed"

    # 1. 取 basename，剥离路径前缀
    # 作用：防止 ../../../etc/passwd 这类路径遍历
    # 同时处理 / 和 \ 两种分隔符（跨平台）
    filename = filename.replace("\\", "/")
    filename = filename.split("/")[-1]

    # 2. 移除空字节和路径遍历残留
    # 作用：防止空字节注入（file.txt\x00.exe）
    # L-7 修复：原实现 filename.replace("..", "_") 会误伤合法文件名（如 report..final.pdf）
    #   basename 提取（步骤1）已剥离路径前缀，残留的 .. 不再构成路径遍历
    #   仅当整个 basename 为 ".." 或 "." 时才替换（防边界情况）
    filename = filename.replace("\x00", "")
    if filename in ("..", "."):
        filename = "_"

    # 3. 移除控制字符（ASCII 0-31）
    # 作用：防止控制字符导致文件系统异常
    filename = "".join(
        char for char in filename if ord(char) >= 32 or char == " "
    )

    # 4. 替换危险字符
    # 作用：防止特殊字符导致命令注入或路径异常
    dangerous_chars = ['<', '>', ':', '"', '|', '?', '*']
    for char in dangerous_chars:
        filename = filename.replace(char, "_")

    # 5. 处理 Windows 保留设备名
    # 作用：防止 CON、PRN、AUX、NUL、COM1-9、LPT1-9 等保留名
    # 这些名称在 Windows 上会导致文件操作异常
    name_without_ext = filename.split(".")[0].upper()
    windows_reserved = {
        "CON", "PRN", "AUX", "NUL",
        "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
        "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    }
    if name_without_ext in windows_reserved:
        filename = f"_{filename}"

    # 6. 限制长度
    # 作用：防止超长文件名导致文件系统错误
    if len(filename) > max_length:
        # 保留扩展名
        if "." in filename:
            name, ext = filename.rsplit(".", 1)
            max_name_len = max_length - len(ext) - 1
            filename = name[:max_name_len] + "." + ext
        else:
            filename = filename[:max_length]

    # 7. 处理边缘情况
    # 作用：确保返回非空、非全点字符串
    if not filename or filename.strip(". ") == "":
        return "unnamed"

    # 8. 去除首尾空格和点
    # 作用：防止以点开头的隐藏文件（Unix）或以空格结尾的文件名异常
    filename = filename.strip(". ")

    if not filename:
        return "unnamed"

    return filename


# ============================================
# 文档标题安全校验 - 任务4
# ============================================

# 危险字符黑名单正则
# 作用：匹配控制字符（0x00-0x1f, 0x7f）、Windows 非法文件名字符、
#       HTML 标签分隔符 < >、路径分隔符 / \、路径遍历 ../
_DANGEROUS_TITLE_PATTERN = re.compile(
    r'[\x00-\x1f\x7f<>:"/\\|?*]'   # 控制字符 + Windows 非法字符 + HTML 标签分隔符
    r'|\.\./'                       # 路径遍历序列
    r'|^\.\.+$'                     # 纯点号
)


def validate_document_title(title: str) -> str:
    """
    校验并清洗文档标题（任务4）

    作用：
        对用户输入的文档标题进行安全校验，防止：
        1. 路径遍历攻击（../ 序列）
        2. XSS 攻击（<script> 等 HTML 标签 → HTML 实体转义）
        3. 控制字符注入（0x00-0x1f）
        4. Windows 非法文件名字符（<>:"/\\|?*）
        5. 过长标题（DB 限制 200 字符）

    实现方式：
        1. 非空 + 长度校验
        2. 危险字符正则检测（命中即拒绝，不尝试清洗，避免误伤）
        3. HTML 实体转义（存储转义，前端渲染时浏览器自动反转义显示）

    参数：
        title: str - 用户输入的原始标题

    返回:
        str - 校验通过并 HTML 转义后的安全标题

    异常:
        ValueError - 标题为空、过长或包含不可清洗的危险字符

    使用示例:
        >>> validate_document_title("Python指南")
        'Python指南'
        >>> validate_document_title("<script>alert(1)</script>")
        ValueError: 标题包含非法字符（控制字符、路径符号或 HTML 标签）
    """
    if not title or not isinstance(title, str) or not title.strip():
        raise ValueError("标题不能为空")

    title = title.strip()

    # 长度校验（DB 字段 String(200)）
    if len(title) > 200:
        raise ValueError("标题长度不能超过 200 字符")

    # 危险字符检测：命中即拒绝
    # 作用：路径遍历、控制字符、HTML 标签分隔符等不可清洗，直接拒绝
    if _DANGEROUS_TITLE_PATTERN.search(title):
        raise ValueError("标题包含非法字符（控制字符、路径符号或 HTML 标签）")

    # HTML 实体转义（防 XSS 存储）
    # 作用：< → &lt;、> → &gt;、" → &quot;、' → &#x27;、& → &amp;
    #       前端渲染时浏览器自动反转义，用户看到原始字符，但无法执行脚本
    title = html.escape(title, quote=True)

    return title
