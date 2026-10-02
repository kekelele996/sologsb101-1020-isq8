/**
 * /collab 联编对账
 * 合作馆编目系统送件后：按收藏号认同一件拓本、按行号字位认一个字位；
 * 只在一边有的字位先记「待核」，编目员看过实物认定后才把对方释文并入本馆损泐，
 * 本馆备注保留；对方数据只读改不了。对账失败可只重试退回项，已认定的留着。
 * 消费 Collab、Rubbing、Loss；复用 <FilterBar>、<StatBadge>、<EmptyPanel>、<LossTag>。
 */
import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Col,
  Form,
  Input,
  Modal,
  Radio,
  Row,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  ReloadOutlined,
  UndoOutlined,
} from '@ant-design/icons';
import EmptyPanel from '@/components/common/EmptyPanel';
import FilterBar, { useFilterQuery, type FilterSelectConfig } from '@/components/common/FilterBar';
import StatBadge from '@/components/common/StatBadge';
import LossTag from '@/components/common/LossTag';
import { useAppDispatch, useAppSelector } from '@/stores/store';
import {
  confirmCollabItem,
  reconcileBatch,
  retryReturnedItems,
  returnCollabItem,
  selectCollabBatches,
  selectCollabItems,
  selectFilteredCollabItems,
  setCollabConfirmStates,
  setCollabKinds,
  setCollabKeyword,
  setCurrentBatch,
} from '@/stores/collabSlice';
import { selectRubbings } from '@/stores/rubbingSlice';
import {
  COLLAB_BATCH_STATUS_COLOR,
  COLLAB_BATCH_STATUS_LABEL,
  COLLAB_CONFIRM_STATE_COLOR,
  COLLAB_CONFIRM_STATE_LABEL,
  COLLAB_ITEM_KIND_COLOR,
  COLLAB_ITEM_KIND_LABEL,
  COLLAB_RESOLUTION_LABEL,
  type CollabConfirmState,
  type CollabItem,
  type CollabItemKind,
  type CollabResolution,
} from '@/types/collab';
import { encodeCoord } from '@/utils/collate';

const FILTER_KEYS = ['kind', 'state'] as const;

export default function CollabView() {
  const { message } = AntdApp.useApp();
  const dispatch = useAppDispatch();
  const [form] = Form.useForm<{ resolution: CollabResolution; operator: string; reason: string }>();

  const batches = useAppSelector(selectCollabBatches);
  const allItems = useAppSelector(selectCollabItems);
  const items = useAppSelector(selectFilteredCollabItems);
  const rubbings = useAppSelector(selectRubbings);
  const currentBatchId = useAppSelector((state) => state.collab.currentBatchId);
  const ready = useAppSelector((state) => state.collab.ready);

  const url = useFilterQuery(FILTER_KEYS);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [returnOpen, setReturnOpen] = useState(false);
  const [editing, setEditing] = useState<CollabItem | null>(null);

  const currentBatch = batches.find((batch) => batch.id === currentBatchId) ?? null;
  const batchItems = useMemo(
    () => allItems.filter((item) => item.batchId === currentBatchId),
    [allItems, currentBatchId],
  );

  // 首次进入「待对账」批次自动跑一次对账（幂等）
  useEffect(() => {
    if (ready && currentBatch && currentBatch.status === 'open' && batchItems.length === 0) {
      void dispatch(reconcileBatch(currentBatch.id));
    }
  }, [ready, currentBatch, batchItems.length, dispatch]);

  useEffect(() => {
    dispatch(setCollabKeyword(url.keyword));
    dispatch(setCollabKinds((url.values.kind ?? []) as CollabItemKind[]));
    dispatch(setCollabConfirmStates((url.values.state ?? []) as CollabConfirmState[]));
  }, [dispatch, url.keyword, url.values]);

  const counts = useMemo(() => {
    const pending = batchItems.filter((item) => item.confirmState === 'pending').length;
    const confirmed = batchItems.filter((item) => item.confirmState === 'confirmed').length;
    const returned = batchItems.filter((item) => item.confirmState === 'returned').length;
    const matched = batchItems.filter((item) => item.kind === 'matched').length;
    return { pending, confirmed, returned, matched };
  }, [batchItems]);

  const rubbingTitle = (rubbingId: string | null): string => {
    if (!rubbingId) return '未匹配拓本';
    const rubbing = rubbings.find((item) => item.id === rubbingId);
    return rubbing ? `第 ${rubbing.versionNo} 版` : '已删除拓本';
  };

  const selects: FilterSelectConfig[] = [
    {
      key: 'kind',
      label: '对账种类',
      options: (Object.keys(COLLAB_ITEM_KIND_LABEL) as CollabItemKind[]).map((value) => ({
        value,
        label: COLLAB_ITEM_KIND_LABEL[value],
      })),
    },
    {
      key: 'state',
      label: '认定状态',
      options: (Object.keys(COLLAB_CONFIRM_STATE_LABEL) as CollabConfirmState[]).map((value) => ({
        value,
        label: COLLAB_CONFIRM_STATE_LABEL[value],
      })),
    },
  ];

  const openConfirm = (item: CollabItem): void => {
    setEditing(item);
    const defaultResolution: CollabResolution =
      item.kind === 'conflict'
        ? 'acceptPartner'
        : item.kind === 'onlyOurs'
          ? 'keepOurs'
          : item.ourRubbingId
            ? 'acceptPartner'
            : 'acknowledged';
    form.setFieldsValue({ resolution: defaultResolution, operator: '', reason: '' });
    setConfirmOpen(true);
  };

  const openReturn = (item: CollabItem): void => {
    setEditing(item);
    form.setFieldsValue({ resolution: 'acceptPartner', operator: '', reason: '' });
    setReturnOpen(true);
  };

  const submitConfirm = async (): Promise<void> => {
    if (!editing) return;
    const values = await form.validateFields();
    await dispatch(
      confirmCollabItem({ itemId: editing.id, resolution: values.resolution, operator: values.operator }),
    ).unwrap();
    message.success(`已认定 ${encodeCoord(editing.lineNo, editing.charNo)} 字位`);
    setConfirmOpen(false);
  };

  const submitReturn = async (): Promise<void> => {
    if (!editing) return;
    const values = await form.validateFields();
    await dispatch(returnCollabItem({ itemId: editing.id, reason: values.reason })).unwrap();
    message.success(`已退回 ${encodeCoord(editing.lineNo, editing.charNo)} 字位，可在本批次重试退回项`);
    setReturnOpen(false);
  };

  const columns: ColumnsType<CollabItem> = [
    {
      title: '坐标',
      key: 'coord',
      width: 110,
      render: (_value, record) => <Tag color="#2f3a34">{encodeCoord(record.lineNo, record.charNo)}</Tag>,
    },
    { title: '收藏号', dataIndex: 'collectionNo', width: 110, render: (value: string) => value || '—' },
    {
      title: '种类',
      dataIndex: 'kind',
      width: 100,
      render: (value: CollabItemKind) => <Tag color={COLLAB_ITEM_KIND_COLOR[value]}>{COLLAB_ITEM_KIND_LABEL[value]}</Tag>,
    },
    {
      title: '对方损泐（合作馆）',
      key: 'partner',
      width: 220,
      render: (_value, record) =>
        record.type ? (
          <Space direction="vertical" size={2}>
            <LossTag type={record.type} severity={record.severity ?? undefined} size="small" />
            {record.transcription ? (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                释文：{record.transcription}
              </Typography.Text>
            ) : null}
          </Space>
        ) : (
          <Typography.Text type="secondary">未报此字位</Typography.Text>
        ),
    },
    {
      title: '本馆损泐',
      key: 'ours',
      width: 220,
      render: (_value, record) =>
        record.ourType ? (
          <Space direction="vertical" size={2}>
            <LossTag type={record.ourType} severity={record.ourSeverity ?? undefined} size="small" />
            {record.note ? (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                备注：{record.note}
              </Typography.Text>
            ) : null}
          </Space>
        ) : (
          <Typography.Text type="secondary">本馆无此字位</Typography.Text>
        ),
    },
    {
      title: '认定状态',
      key: 'state',
      width: 130,
      render: (_value, record) => (
        <Space direction="vertical" size={2}>
          <Tag color={COLLAB_CONFIRM_STATE_COLOR[record.confirmState]}>
            {COLLAB_CONFIRM_STATE_LABEL[record.confirmState]}
          </Tag>
          {record.confirmState === 'confirmed' && record.resolution ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {COLLAB_RESOLUTION_LABEL[record.resolution]}
              {record.confirmedBy ? ` · ${record.confirmedBy}` : ''}
            </Typography.Text>
          ) : null}
          {record.confirmState === 'returned' && record.returnReason ? (
            <Typography.Text type="warning" style={{ fontSize: 12 }}>
              退回：{record.returnReason}
            </Typography.Text>
          ) : null}
        </Space>
      ),
    },
    {
      title: '操作',
      key: 'action',
      width: 150,
      render: (_value, record) =>
        record.kind === 'matched' ? (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            自动认定
          </Typography.Text>
        ) : (
          <Space size={4}>
            <Button
              size="small"
              type="link"
              icon={<CheckCircleOutlined />}
              onClick={() => openConfirm(record)}
            >
              认定
            </Button>
            {record.confirmState !== 'returned' ? (
              <Button size="small" type="link" danger icon={<CloseCircleOutlined />} onClick={() => openReturn(record)}>
                退回
              </Button>
            ) : null}
          </Space>
        ),
    },
  ];

  const resolutionOptions: { value: CollabResolution; label: string; description: string }[] =
    editing?.kind === 'conflict'
      ? [
          { value: 'acceptPartner', label: '采纳对方记录', description: '以对方损泐类型 / 程度为准，释文并入本馆' },
          { value: 'keepOurs', label: '保留本馆记录', description: '本馆损泐不动，仅并入对方释文' },
        ]
      : editing?.kind === 'onlyOurs'
        ? [{ value: 'keepOurs', label: '保留本馆记录', description: '对方漏报此字位，本馆记录无误' }]
        : editing?.ourRubbingId
          ? [{ value: 'acceptPartner', label: '采纳对方记录', description: '在本馆该字位新建损泐，释文并入' }]
          : [{ value: 'acknowledged', label: '确认对方记录属实', description: '本馆无对应拓本，仅认定对方数据' }];

  return (
    <div>
      <div className="gb-page-head">
        <div>
          <h2>联编对账</h2>
          <p>
            合作馆编目系统只送拓本与损泐字位，那边改不了；两边各自持有自己那份。按收藏号认同一件拓本，
            只在一边有的字位先记待核，编目员看过实物认定后才算数。
          </p>
        </div>
        <Space wrap>
          <Button
            icon={<ReloadOutlined />}
            onClick={() => currentBatch && void dispatch(reconcileBatch(currentBatch.id))}
          >
            重新对账
          </Button>
          <Button
            type="primary"
            danger
            icon={<UndoOutlined />}
            disabled={counts.returned === 0}
            onClick={() => currentBatch && void dispatch(retryReturnedItems(currentBatch.id))}
          >
            重试退回项（{counts.returned}）
          </Button>
        </Space>
      </div>

      <div className="gb-stat-row">
        <StatBadge label="待核" value={counts.pending} suffix="字位" tone="warning" />
        <StatBadge label="已认定" value={counts.confirmed} suffix="字位" tone="success" />
        <StatBadge label="已退回" value={counts.returned} suffix="字位" tone="danger" />
        <StatBadge label="双方一致" value={counts.matched} suffix="字位" tone="info" />
        <StatBadge label="当前批次" value={currentBatch?.batchNo ?? '—'} tone="primary" />
      </div>

      <Row gutter={16}>
        <Col xs={24} md={7} lg={6}>
          <Card size="small" title="合作馆送件批次" styles={{ body: { padding: 10 } }}>
            {batches.length === 0 ? (
              <EmptyPanel title="暂无送件批次" description="合作馆送件后在此按批次对账。" size="small" />
            ) : (
              <Space direction="vertical" size={8} style={{ width: '100%' }}>
                {batches.map((batch) => {
                  const active = batch.id === currentBatchId;
                  const batchItemCount = allItems.filter((item) => item.batchId === batch.id).length;
                  return (
                    <Card
                      key={batch.id}
                      size="small"
                      className={active ? 'is-active' : ''}
                      style={{
                        cursor: 'pointer',
                        borderColor: active ? '#2f3a34' : undefined,
                        boxShadow: active ? '0 0 0 2px rgba(47,58,52,0.18)' : undefined,
                      }}
                      onClick={() => dispatch(setCurrentBatch(batch.id))}
                    >
                      <Space direction="vertical" size={2} style={{ width: '100%' }}>
                        <Space size={6} wrap>
                          <Tag color={COLLAB_BATCH_STATUS_COLOR[batch.status]}>
                            {COLLAB_BATCH_STATUS_LABEL[batch.status]}
                          </Tag>
                          <Typography.Text strong>{batch.batchNo}</Typography.Text>
                        </Space>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          {batch.partner} · {batch.sentAt}
                        </Typography.Text>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          对账明细 {batchItemCount} 条
                        </Typography.Text>
                      </Space>
                    </Card>
                  );
                })}
              </Space>
            )}
          </Card>
        </Col>

        <Col xs={24} md={17} lg={18}>
          <FilterBar
            keyword={url.keyword}
            onKeywordChange={url.setKeyword}
            selects={selects}
            values={url.values}
            onValuesChange={url.setValues}
            onReset={url.reset}
            keywordPlaceholder="搜索坐标 / 收藏号 / 释文 / 备注…"
            actions={<Typography.Text type="secondary">明细 {items.length} 条</Typography.Text>}
          />

          <Card className="gb-table-card" style={{ marginTop: 14 }} styles={{ body: { padding: 0 } }}>
            {items.length === 0 ? (
              <EmptyPanel
                title={batchItems.length === 0 ? '该批次尚未对账' : '当前筛选条件下没有明细'}
                description={
                  batchItems.length === 0
                    ? '点击右上角「重新对账」，按收藏号与字位坐标生成对账明细。'
                    : '试着调整种类或认定状态筛选。'
                }
                actionText={batchItems.length === 0 ? '开始对账' : undefined}
                onAction={
                  batchItems.length === 0 && currentBatch
                    ? () => void dispatch(reconcileBatch(currentBatch.id))
                    : undefined
                }
                size="small"
              />
            ) : (
              <Table<CollabItem>
                rowKey="id"
                size="small"
                pagination={{ pageSize: 8 }}
                columns={columns}
                dataSource={items}
              />
            )}
          </Card>

          <Alert
            style={{ marginTop: 14 }}
            type="info"
            showIcon
            message="认定规则"
            description={
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                对方释文并入本馆损泐的「释文」字段；本馆编目员改过的「备注」一律保留、不被覆盖。
                只在一边有的字位先记「待核」，看过实物认定后才生效；没认定的本馆损泐照旧。
                退回后仅重试退回项，已认定的保留；同一批件重复对账不会多出字位。
              </Typography.Text>
            }
          />
        </Col>
      </Row>

      {/* 认定 */}
      <Modal
        open={confirmOpen}
        title={`认定字位 ${editing ? encodeCoord(editing.lineNo, editing.charNo) : ''}`}
        onCancel={() => setConfirmOpen(false)}
        onOk={() => void submitConfirm()}
        okText="认定"
        cancelText="取消"
        destroyOnClose
      >
        {editing ? (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Space size={6} wrap>
              <Tag color={COLLAB_ITEM_KIND_COLOR[editing.kind]}>{COLLAB_ITEM_KIND_LABEL[editing.kind]}</Tag>
              <Tag>{editing.collectionNo}</Tag>
              <Tag>{rubbingTitle(editing.ourRubbingId)}</Tag>
            </Space>

            {!editing.ourRubbingId && editing.kind === 'onlyPartner' ? (
              <Alert
                type="warning"
                showIcon
                message={`本馆按收藏号「${editing.collectionNo}」未找到对应拓本`}
                description="认定后仅确认合作馆该字位记录属实，不会在本馆生成损泐字位；请先在拓本登记中补录该收藏号拓本。"
              />
            ) : null}

            <Row gutter={12}>
              <Col span={12}>
                <Card size="small" title="对方损泐（合作馆）">
                  {editing.type ? (
                    <Space direction="vertical" size={4}>
                      <LossTag type={editing.type} severity={editing.severity ?? undefined} />
                      {editing.transcription ? (
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          释文：{editing.transcription}
                        </Typography.Text>
                      ) : null}
                    </Space>
                  ) : (
                    <Typography.Text type="secondary">未报此字位</Typography.Text>
                  )}
                </Card>
              </Col>
              <Col span={12}>
                <Card size="small" title="本馆损泐">
                  {editing.ourType ? (
                    <Space direction="vertical" size={4}>
                      <LossTag type={editing.ourType} severity={editing.ourSeverity ?? undefined} />
                      {editing.note ? (
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          备注：{editing.note}
                        </Typography.Text>
                      ) : (
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          无备注
                        </Typography.Text>
                      )}
                    </Space>
                  ) : (
                    <Typography.Text type="secondary">本馆无此字位</Typography.Text>
                  )}
                </Card>
              </Col>
            </Row>

            <Form form={form} layout="vertical" preserve={false}>
              <Form.Item name="resolution" label="认定方式" rules={[{ required: true }]}>
                <Radio.Group>
                  <Space direction="vertical">
                    {resolutionOptions.map((option) => (
                      <Radio key={option.value} value={option.value}>
                        {option.label}
                        <Typography.Text type="secondary" style={{ fontSize: 12, marginInlineStart: 8 }}>
                          {option.description}
                        </Typography.Text>
                      </Radio>
                    ))}
                  </Space>
                </Radio.Group>
              </Form.Item>
              <Form.Item name="operator" label="认定人">
                <Input placeholder="如：傅砚（看过实物后认定）" />
              </Form.Item>
            </Form>
          </Space>
        ) : null}
      </Modal>

      {/* 退回 */}
      <Modal
        open={returnOpen}
        title={`退回字位 ${editing ? encodeCoord(editing.lineNo, editing.charNo) : ''}`}
        onCancel={() => setReturnOpen(false)}
        onOk={() => void submitReturn()}
        okText="确认退回"
        okButtonProps={{ danger: true }}
        cancelText="取消"
        destroyOnClose
      >
        <Form form={form} layout="vertical" preserve={false}>
          <Form.Item
            name="reason"
            label="退回原因"
            rules={[{ required: true, message: '请填写退回原因，便于合作馆核对' }]}
          >
            <Input.TextArea rows={3} placeholder="如：该字位本馆实物无此损泐，对方释文与原石不符" />
          </Form.Item>
        </Form>
        <Alert type="info" showIcon message="退回后该字位标记为「已退回」，可在本批次点击「重试退回项」重新对账；已认定的字位不受影响。" />
      </Modal>
    </div>
  );
}
