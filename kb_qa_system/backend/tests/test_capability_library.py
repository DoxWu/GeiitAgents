import json
from uuid import uuid4
import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool
from app.api.routes import capabilities
from app.core.database import Base
from app.models.user import User
from app.models.organization import Organization, OrganizationMembership
from app.models.capability import SharedCapability
from app.models.audit_log import AuditLog
from app.schemas.capability import CapabilityPublish, CapabilitySpec

@pytest.fixture
def db():
    engine=create_engine('sqlite://',connect_args={'check_same_thread':False},poolclass=StaticPool)
    Base.metadata.create_all(engine,tables=[User.__table__,Organization.__table__,OrganizationMembership.__table__,SharedCapability.__table__,AuditLog.__table__])
    with Session(engine,expire_on_commit=False) as session:
        yield session
    engine.dispose()

def resource():
    return CapabilitySpec(id=uuid4(),name='Fixture skill',kind='skill',version=1,description='',content='Summarize evidence.')

def test_approval_scopes_and_membership_revocation(db):
    owner=User(id=1,username='owner',email='owner@example.test',hashed_password='hash')
    admin=User(id=2,username='admin',email='admin@example.test',hashed_password='hash')
    stranger=User(id=3,username='stranger',email='stranger@example.test',hashed_password='hash')
    db.add_all([owner,admin,stranger]);db.flush();db.add(Organization(id=1,name='Alpha',slug='alpha',created_by=2));db.flush()
    member=OrganizationMembership(organization_id=1,user_id=1,role='member',status='active')
    db.add_all([member,OrganizationMembership(organization_id=1,user_id=2,role='org_admin',status='active')]);db.commit()
    item=capabilities.publish(CapabilityPublish(resource=resource(),organizationId=1),db,owner)
    assert item['status']=='pending'
    with pytest.raises(HTTPException):capabilities.get_resource(item['id'],db,owner)
    with pytest.raises(HTTPException):capabilities.review(item['id'],capabilities.Decision(approved=True),db,stranger)
    capabilities.review(item['id'],capabilities.Decision(approved=True),db,admin)
    assert capabilities.get_resource(item['id'],db,owner)['status']=='published'
    with pytest.raises(HTTPException):capabilities.get_resource(item['id'],db,stranger)
    member.status='removed';db.commit()
    with pytest.raises(HTTPException):capabilities.get_resource(item['id'],db,owner)
    assert capabilities.list_resources(db,owner)==[]
    capabilities.review(item['id'],capabilities.Decision(approved=False),db,admin)
    with pytest.raises(HTTPException):capabilities.get_resource(item['id'],db,admin)

def test_mcp_contract_rejects_credentials_and_invalid_values():
    fields=[dict(key='result',label='Result',type='string',required=True,description='')]
    base=dict(id=uuid4(),name='MCP',kind='mcp',version=1,description='',content='',toolName='lookup',inputFields=fields,outputFields=fields)
    for endpoint in ['http://example.com/mcp','https://user:secret@example.com/mcp','https://example.com:8443/mcp','https://example.com/mcp?token=x']:
        with pytest.raises(ValueError):CapabilitySpec(**base,endpoint=endpoint)
    spec=CapabilitySpec(**base,endpoint='https://example.com/mcp')
    with pytest.raises(ValueError):capabilities.check_values({'result':3},spec.inputFields)
    with pytest.raises(ValueError):capabilities.check_values({'result':'ok','extra':True},spec.inputFields)
    capabilities.check_values({'result':'ok'},spec.inputFields)

def test_mcp_transport_pins_each_request_and_closes_responses(monkeypatch):
    from app.services import mcp_client
    calls=[];closed=[]
    class Response:
        status_code=200
        headers={'Content-Type':'application/json','Mcp-Session-Id':'fixture'}
        def __init__(self,body):self.body=body
        def iter_content(self,*args):yield json.dumps(self.body).encode()
        def close(self):closed.append(True)
    def transport(method,url,**kwargs):
        body=kwargs['json'];calls.append(body)
        result={'protocolVersion':'2025-03-26'} if body['method']=='initialize' else {'structuredContent':{'result':'ok'}}
        return Response({'jsonrpc':'2.0','id':body.get('id'),'result':result})
    monkeypatch.setattr(mcp_client,'public_request',transport)
    assert mcp_client.call_mcp('https://example.test/mcp','lookup',{'query':'fixture'})=={'result':'ok'}
    assert [c['method'] for c in calls]==['initialize','notifications/initialized','tools/call']
    assert len(closed)==3


def test_mcp_crlf_sse_split_utf8_and_negotiated_protocol(monkeypatch):
    from app.services import mcp_client
    protocols=[];closed=[]
    class Response:
        status_code=200
        headers={'Content-Type':'text/event-stream','Mcp-Session-Id':'fixture'}
        def __init__(self,body):self.body=body
        def iter_content(self,*args):
            # One-byte chunks exercise partial UTF-8, CRLF and event boundaries.
            yield from (bytes([byte]) for byte in self.body)
        def close(self):closed.append(True)
    def transport(method,url,**kwargs):
        body=kwargs['json'];protocols.append(kwargs['headers']['MCP-Protocol-Version'])
        result={'protocolVersion':'2025-06-18'} if body['method']=='initialize' else {'structuredContent':{'result':'中文'}}
        data=json.dumps({'jsonrpc':'2.0','id':body.get('id'),'result':result},ensure_ascii=False)
        return Response(('event: message\r\ndata: '+data+'\r\n\r\n').encode())
    monkeypatch.setattr(mcp_client,'public_request',transport)
    assert mcp_client.call_mcp('https://example.test/mcp','lookup',{})=={'result':'中文'}
    assert protocols==['2025-03-26','2025-06-18','2025-06-18']
    assert len(closed)==3


def test_workflow_dependencies_require_approved_matching_scope_and_version(db):
    from app.api.routes.organizations import _workflow_capabilities
    owner=User(id=1,username='owner',email='owner@example.test',hashed_password='hash',is_superuser=True)
    db.add(owner);db.commit()
    item=capabilities.publish(CapabilityPublish(resource=resource()),db,owner)
    snapshot={**item['resource'],'sharedId':item['id']}
    definition={'workflow':{'nodes':[{'agent':{'capabilities':[snapshot]}}]}}
    _workflow_capabilities(db,owner,definition,1)
    snapshot['content']='modified private content'
    with pytest.raises(HTTPException) as changed:_workflow_capabilities(db,owner,definition,1)
    assert changed.value.status_code==409
    snapshot['content']=item['resource']['content'];snapshot.pop('sharedId')
    with pytest.raises(HTTPException) as private:_workflow_capabilities(db,owner,definition,1)
    assert private.value.status_code==422
    owner.is_active=False;db.commit()
    with pytest.raises(HTTPException):capabilities.get_resource(item['id'],db,owner)


def test_mcp_http_route_consent_no_store_contract_and_mid_call_revocation(db,monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from app.services import request_concurrency
    from test_concurrency_controls import FakeAsyncRedis
    from unittest.mock import Mock
    monkeypatch.setattr(request_concurrency,'async_redis_client',FakeAsyncRedis())
    owner=User(id=1,username='owner',email='owner@example.test',hashed_password='hash',is_superuser=True)
    db.add(owner);db.commit()
    fields=[dict(key='result',label='Result',type='string',required=True,description='')]
    spec=CapabilitySpec(id=uuid4(),name='MCP',kind='mcp',version=1,description='',content='',endpoint='https://example.test/mcp',toolName='lookup',inputFields=fields,outputFields=fields)
    item=capabilities.publish(CapabilityPublish(resource=spec),db,owner)
    app=FastAPI();app.include_router(capabilities.router)
    app.dependency_overrides[capabilities.get_current_active_user]=lambda:owner
    app.dependency_overrides[capabilities.get_current_regular_user]=lambda:owner
    app.dependency_overrides[capabilities.get_db]=lambda:db
    remote=Mock(return_value={'result':'ok'});monkeypatch.setattr(capabilities,'call_mcp',remote)
    with TestClient(app) as client:
        url=f"/capabilities/{item['id']}/call"
        denied=client.post(url,json={'inputs':{'result':'fixture'},'consent':False})
        assert denied.status_code==403 and denied.headers['cache-control']=='no-store'
        remote.assert_not_called()
        malformed=client.post(url,json={'inputs':{'result':'fixture'},'consent':True,'api_key':'synthetic-secret'})
        assert malformed.status_code==422 and 'synthetic-secret' not in malformed.text
        response=client.post(url,json={'inputs':{'result':'fixture'},'consent':True})
        assert response.status_code==200 and response.json()=={'output':{'result':'ok'}}
        assert response.headers['cache-control']=='no-store'
        def revoke(*args):
            row=db.query(SharedCapability).filter_by(id=item['id']).one();row.status='disabled';db.commit()
            return {'result':'private output'}
        remote.side_effect=revoke
        response=client.post(url,json={'inputs':{'result':'fixture'},'consent':True})
        assert response.status_code==404 and 'private output' not in response.text
        assert db.query(AuditLog).filter(AuditLog.action=='capability.call_succeeded').count()==1
