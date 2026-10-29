"""
注册审批相关 Schema

作用：
    定义注册申请、审批、设置密码等接口的请求和响应数据模型。
    与前端 types/user.ts 中的类型定义对齐。

实现方式：
    1. 使用 Pydantic v2 BaseModel
    2. 密码复杂度校验复用 schemas/user.py 的正则模式
    3. ApplicationStatusResponse 不含 token 字段（安全要求）
"""

from datetime import datetime
from typing import Optional, List
from pydantic import BaseModel, Field, EmailStr, ConfigDict, field_validator
import re

# 复用 schemas/user.py 的校验正则，保持一致性
_USERNAME_PATTERN = re.compile(r"^[a-zA-Z0-9_\-\u4e00-\u9fa5]+$")
_PASSWORD_LETTER = re.compile(r"[a-zA-Z]")
_PASSWORD_DIGIT = re.compile(r"[0-9]")


# ============================================
# 注册申请
# ============================================

class RegisterApplyRequest(BaseModel):
    """
    注册申请请求 Schema

    作用：
        定义 POST /auth/register/apply 接口的请求体格式。

    对齐前端：
        frontend/src/types/user.ts → RegisterApplyRequest
    """
    email: EmailStr = Field(..., description="申请人邮箱")
    organization_id: Optional[int] = Field(None, ge=1)
    username: str = Field(
        ...,
        min_length=3,
        max_length=50,
        description="申请用户名，3-50 字符，仅支持字母、数字、下划线、横线、中文"
    )

    @field_validator("username")
    @classmethod
    def validate_username_pattern(cls, v: str) -> str:
        """校验用户名字符模式（与注册接口一致）"""
        if not _USERNAME_PATTERN.match(v):
            raise ValueError("用户名只能包含字母、数字、下划线、横线和中文")
        return v


class RegisterApplyResponse(BaseModel):
    """
    注册申请响应 Schema

    对齐前端：
        frontend/src/types/user.ts → RegisterApplyResponse
    """
    application_id: int = Field(..., description="申请 ID")
    status: str = Field(..., description="申请状态（固定 pending）")
    message: str = Field(..., description="提示消息")


class ApplicationStatusResponse(BaseModel):
    """
    申请状态查询响应 Schema

    安全：
        不包含 password_token 相关字段，防止通过状态查询接口泄露 Token。

    对齐前端：
        frontend/src/types/user.ts → ApplicationStatusResponse
    """
    status: str = Field(..., description="申请状态（pending/approved/rejected）")
    email: str = Field(..., description="申请人邮箱")
    username: str = Field(..., description="申请用户名")
    submitted_at: datetime = Field(..., description="提交时间")
    reviewed_at: Optional[datetime] = Field(None, description="审批时间")
    reject_reason: Optional[str] = Field(None, description="拒绝原因")

    model_config = ConfigDict(from_attributes=True)


# ============================================
# 管理员审批
# ============================================

class ApplicationListItem(BaseModel):
    """
    申请列表项 Schema（管理员查看）

    安全：
        不包含 password_token 相关字段。
    """
    id: int
    email: str
    username: str
    status: str
    submitted_at: datetime
    reviewed_at: Optional[datetime] = None
    reviewed_by: Optional[int] = None
    reject_reason: Optional[str] = None
    organization_id: Optional[int] = None

    model_config = ConfigDict(from_attributes=True)


class ApplicationListResponse(BaseModel):
    """
    申请列表响应 Schema（管理员查看）
    """
    items: List[ApplicationListItem]
    total: int = Field(..., description="申请总数")
    pending_count: int = Field(..., description="待审批数量")


class ApproveRequest(BaseModel):
    """
    批准申请请求 Schema
    """
    application_id: int = Field(..., description="申请 ID")
    organization_id: Optional[int] = Field(None, ge=1)


class RejectRequest(BaseModel):
    """
    拒绝申请请求 Schema

    安全：
        reject_reason 必填（min_length=1），防止无理由拒绝。
    """
    application_id: int = Field(..., description="申请 ID")
    reject_reason: str = Field(
        ...,
        min_length=1,
        max_length=500,
        description="拒绝原因（必填，1-500 字符）"
    )


# ============================================
# 设置密码
# ============================================

class SetPasswordRequest(BaseModel):
    """
    设置密码请求 Schema

    对齐前端：
        frontend/src/types/user.ts → SetPasswordRequest
    """
    token: str = Field(
        ...,
        min_length=10,
        max_length=100,
        description="邮件链接中的密码设置 Token"
    )
    password: str = Field(
        ...,
        min_length=8,
        max_length=100,
        description="新密码，8-100 字符，必须包含字母和数字"
    )

    @field_validator("password")
    @classmethod
    def validate_password_complexity(cls, v: str) -> str:
        """校验密码复杂度（与注册接口一致）"""
        if not _PASSWORD_LETTER.search(v):
            raise ValueError("密码必须包含至少一个字母")
        if not _PASSWORD_DIGIT.search(v):
            raise ValueError("密码必须包含至少一个数字")
        return v


class SetPasswordResponse(BaseModel):
    """
    设置密码响应 Schema
    """
    success: bool = Field(..., description="是否成功")
    message: str = Field(..., description="提示消息")
