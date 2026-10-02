/**
 * /reconcile 合作馆联编对账
 * 导入合作馆送出的拓本与损泐字位；按收藏号认拓本，双方字位各自留档，待核项需编目员看物认定。
 */
import { useMemo, useRef, useState, type ChangeEvent } from 'react';
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Col,
  Form,
  Input,
  Modal,
  Popconfirm,
  Row,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { CloudUploadOutlined, FileSearchOutlined, ReloadOutlined } from '@ant-design/icons';
import EmptyPanel from '@/components/common/EmptyPanel';
import LossTag from '@/components/common/LossTag';
import StatBadge from '@/components/common/StatBadge';
import { useAppDispatch, useAppSelector } from '@/stores/store';
import { loadLosses } from '@/stores/lossSlice';
import {
  loadReconciliation,
  receivePartnerBatch,
  retryReconciliationBatch,
  reviewReconciliationItem,
  selectReconciliationBatches,
  selectReconciliationItems,
  setSelectedBatch,
} from '@/stores/reconciliationSlice';
import { LOSS_SEVERITY_LABEL, LOSS_TYPE_LABEL, type LossSeverity, type LossType } from '@/types/loss';
import {
  RECONCILIATION_BATCH_STATUS_LABEL,
  RECONCILIATION_ITEM_STATUS_COLOR,
  RECONCILIATION_ITEM_STATUS_LABEL,
  RECONCILIATION_PENDING_STATUSES,
  type ReconciliationBatch,
  type ReconciliationDecision,
  type ReconciliationItem,
} from '@/types/reconciliation';
import { encodeCoord } from '@/utils/collate';
import { download } from '@/utils/export';

const SAMPLE_BATCH = {
  batchId: `PARTNER-SAMPLE-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`,
  partnerName: '合作馆',
  sentAt: Date.now(),
  rubbings: [
    {
      collectionNo: 'TB-0102',
      losses: [
        { lineNo: 3, charNo: 7, type: 'blur', severity: 'medium', transcription: '示例：「壽」字右下漫漶' },
        { lineNo: 14, charNo: 2, type: 'crack', severity: 'light', transcription: '示例：合作馆另见细裂' },
      ],
    },
  ],
};

function formatTime(value?: number | null): string {
  return value ? new Date(value).toLocaleString('zh-CN') : '—';
}

export default function ReconcileView() {
  const { message } = AntdApp.useApp();
  const dispatch = useAppDispatch();
  const fileRef = useRef<HTMLInputElement>(null);
  const [reviewForm] = Form.useForm<{ reviewedBy: string; reviewNote: string }>();
  const [importing, setImporting] = useState(false);
  const [reviewing, setReviewing] = useState<{ item: ReconciliationItem; decision: ReconciliationDecision } | null>(null);

  const batches = useAppSelector(selectReconciliationBatches);
  const items = useAppSelector(selectReconciliationItems);
  const selectedBatchId = useAppSelector((state) => state.reconciliation.selectedBatchId);

  const selectedBatch = batches.find((batch) => batch.id === selectedBatchId) ?? batches[0] ?? null;
  const selectedItems = useMemo(
    () => items.filter((item) => item.batchId === selectedBatch?.id),
    [items, selectedBatch?.id],
  );

  const stats = useMemo(
    () => ({
      batches: batches.length,
      failed: batches.filter((batch) => batch.status === 'failed').length,
      pending: items.filter((item) => RECONCILIATION_PENDING_STATUSES.includes(item.status)).length,
      decided: items.filter(
        (item) => item.status.startsWith('confirmed') || item.status.startsWith('rejected'),
      ).length,
      matched: items.filter((item) => item.status === 'matched').length,
    }),
    [batches.length, batches, items],
  );

  const refresh = async (): Promise<void> => {
    await Promise.all([dispatch(loadReconciliation()), dispatch(loadLosses())]);
  };

  const importFile = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setImporting(true);
    try {
      const parsed: unknown = JSON.parse(await file.text());
      const result = await dispatch(receivePartnerBatch(parsed)).unwrap();
      await refresh();
      if (result.reused) message.info('同一批已成功对账过，未重复生成字位');
      else message.success(`批次 ${result.batch.id} 对账完成：新增 ${result.createdItemCount} 项，更新 ${result.updatedItemCount} 项`);
    } catch (error) {
      await dispatch(loadReconciliation());
      message.error(`对账失败，已登记退回批次：${error instanceof Error ? error.message : '未知错误'}`);
    } finally {
      setImporting(false);
    }
  };

  const retryBatch = async (batchId: string): Promise<void> => {
    try {
      const result = await dispatch(retryReconciliationBatch(batchId)).unwrap();
      await refresh();
      message.success(`退回批次重试完成：新增 ${result.createdItemCount} 项，更新 ${result.updatedItemCount} 项`);
    } catch (error) {
      await dispatch(loadReconciliation());
      message.error(error instanceof Error ? error.message : '重试失败');
    }
  };

  const openReview = (item: ReconciliationItem, decision: ReconciliationDecision): void => {
    setReviewing({ item, decision });
    reviewForm.setFieldsValue({ reviewedBy: '', reviewNote: '' });
  };

  const submitReview = async (): Promise<void> => {
    if (!reviewing) return;
    const values = await reviewForm.validateFields();
    await dispatch(
      reviewReconciliationItem({
        id: reviewing.item.id,
        decision: reviewing.decision,
        reviewedBy: values.reviewedBy,
        reviewNote: values.reviewNote,
      }),
    ).unwrap();
    await refresh();
    message.success('已记录看物认定');
    setReviewing(null);
  };

  const batchColumns: ColumnsType<ReconciliationBatch> = [
    { title: '批次号', dataIndex: 'id', width: 180 },
    { title: '合作馆', dataIndex: 'partnerName', width: 100 },
    {
      title: '状态',
      dataIndex: 'status',
      width: 120,
      render: (value: ReconciliationBatch['status']) => (
        <Tag color={value === 'failed' ? 'red' : 'green'}>{RECONCILIATION_BATCH_STATUS_LABEL[value]}</Tag>
      ),
    },
    { title: '次数', dataIndex: 'attemptCount', width: 70 },
    { title: '拓本', dataIndex: 'rubbingCount', width: 70 },
    { title: '对方字位', dataIndex: 'partnerLossCount', width: 90 },
    { title: '本馆字位', dataIndex: 'localLossCount', width: 90 },
    {
      title: '最近接收',
      dataIndex: 'receivedAt',
      width: 170,
      render: (value: number) => formatTime(value),
    },
    {
      title: '失败原因 / 操作',
      key: 'error',
      render: (_value, record) =>
        record.status === 'failed' ? (
          <Space direction="vertical" size={2}>
            <Typography.Text type="danger">{record.errorMessage}</Typography.Text>
            <Button size="small" type="link" icon={<ReloadOutlined />} onClick={() => void retryBatch(record.id)}>
              只重试该退回批次
            </Button>
          </Space>
        ) : (
          <Typography.Text type="secondary">已完成；重复送同批不会多出字位</Typography.Text>
        ),
    },
  ];

  const itemColumns: ColumnsType<ReconciliationItem> = [
    {
      title: '收藏号 / 字位',
      key: 'coord',
      width: 150,
      render: (_value, record) => (
        <Space direction="vertical" size={2}>
          <Tag color="#2f3a34">{record.collectionNo}</Tag>
          <Typography.Text strong>{encodeCoord(record.lineNo, record.charNo)}</Typography.Text>
        </Space>
      ),
    },
    {
      title: '对账状态',
      dataIndex: 'status',
      width: 150,
      render: (value: ReconciliationItem['status']) => (
        <Tag color={RECONCILIATION_ITEM_STATUS_COLOR[value]}>{RECONCILIATION_ITEM_STATUS_LABEL[value]}</Tag>
      ),
    },
    {
      title: '本馆字位（编目员维护）',
      key: 'local',
      width: 250,
      render: (_value, record) => {
        if (!record.localSnapshot || 'removed' in record.localSnapshot) return <Typography.Text type="secondary">本馆无登记</Typography.Text>;
        const loss = record.localSnapshot;
        return (
          <Space direction="vertical" size={2}>
            <LossTag
              type={loss.type as LossType}
              severity={loss.severity as LossSeverity}
              note={loss.note}
              size="small"
            />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {LOSS_TYPE_LABEL[loss.type as LossType]} / {LOSS_SEVERITY_LABEL[loss.severity as LossSeverity]}
            </Typography.Text>
          </Space>
        );
      },
    },
    {
      title: '合作馆字位（对方维护）',
      key: 'partner',
      width: 250,
      render: (_value, record) =>
        record.partnerSnapshot ? (
          <Space direction="vertical" size={2}>
            <LossTag
              type={record.partnerSnapshot.type}
              severity={record.partnerSnapshot.severity}
              note={record.partnerSnapshot.transcription}
              size="small"
            />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {LOSS_TYPE_LABEL[record.partnerSnapshot.type]} / {LOSS_SEVERITY_LABEL[record.partnerSnapshot.severity]}
            </Typography.Text>
          </Space>
        ) : (
          <Typography.Text type="secondary">对方无登记</Typography.Text>
        ),
    },
    {
      title: '释文',
      key: 'transcriptions',
      render: (_value, record) => (
        <Space direction="vertical" size={2}>
          <span>本馆备注：{record.localSnapshot && !('removed' in record.localSnapshot) ? record.localSnapshot.note || '—' : '—'}</span>
          <Typography.Text type="success">
            对方补释：{record.partnerSnapshot?.transcription || '—'}
          </Typography.Text>
          {record.reviewedAt ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {record.reviewedBy || '编目员'} 于 {formatTime(record.reviewedAt)} 认定{record.reviewNote ? `：${record.reviewNote}` : ''}
            </Typography.Text>
          ) : null}
        </Space>
      ),
    },
    {
      title: '看物认定',
      key: 'actions',
      width: 220,
      render: (_value, record) => {
        if (!RECONCILIATION_PENDING_STATUSES.includes(record.status)) {
          return <Typography.Text type="secondary">已锁定，留档</Typography.Text>;
        }
        if (record.status === 'partnerOnlyPending') {
          return (
            <Space size={4} wrap>
              <Button size="small" type="primary" onClick={() => openReview(record, 'confirmPartner')}>
                采对方
              </Button>
              <Popconfirm
                title="不采合作馆该字位？"
                description="合作馆记录仍保留，本馆损泐不会新增。"
                onConfirm={() => openReview(record, 'rejectPartner')}
              >
                <Button size="small">不采对方</Button>
              </Popconfirm>
            </Space>
          );
        }
        return (
          <Space size={4} wrap>
            <Button size="small" type="primary" onClick={() => openReview(record, 'confirmLocal')}>
              维持本馆
            </Button>
            <Popconfirm
              title="撤销本馆该损泐？"
              description="未看物认定前本馆损泐照旧；认定撤销后此条损泐将被核销，旧记录在对账项留痕。"
              onConfirm={() => openReview(record, 'rejectLocal')}
            >
              <Button size="small" danger>
                撤销本馆
              </Button>
            </Popconfirm>
          </Space>
        );
      },
    },
  ];

  return (
    <div>
      <div className="gb-page-head">
        <div>
          <h2>合作馆联编对账</h2>
          <p>只按收藏号认同一件拓本；双方字位分别留档，仅一边有的字位先记待核，编目员看过实物后才改变本馆记录。</p>
        </div>
        <Space wrap>
          <Button icon={<FileSearchOutlined />} onClick={() => download('合作馆联编批次模板.json', JSON.stringify(SAMPLE_BATCH, null, 2), 'application/json;charset=utf-8')}>
            下载批次模板
          </Button>
          <Button type="primary" loading={importing} icon={<CloudUploadOutlined />} onClick={() => fileRef.current?.click()}>
            导入合作馆批次
          </Button>
          <input ref={fileRef} type="file" accept="application/json,.json" style={{ display: 'none' }} onChange={(event) => void importFile(event)} />
        </Space>
      </div>

      <div className="gb-stat-row">
        <StatBadge label="送件批次" value={stats.batches} suffix="批" tone="primary" />
        <StatBadge label="退回待重试" value={stats.failed} suffix="批" tone="danger" />
        <StatBadge label="待核字位" value={stats.pending} suffix="项" tone="warning" />
        <StatBadge label="已对上" value={stats.matched} suffix="项" tone="success" />
        <StatBadge label="已看物认定" value={stats.decided} suffix="项" tone="info" />
      </div>

      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 14 }}
        message="对账边界"
        description="合作馆系统不可改：对方记录始终独立保存；本馆备注由本馆维护，对方补释只写入「合作馆补释」字段。失败后只重试退回批次，自然主键保证先前认定和同批字位不重复。"
      />

      <Row gutter={16}>
        <Col span={24}>
          <Card className="gb-table-card" title="送件 / 退回批次" styles={{ body: { padding: 0 } }}>
            {batches.length === 0 ? (
              <EmptyPanel
                title="还没有合作馆批次"
                description="下载 JSON 模板，交由合作馆或通过交换文件导入；系统会按拓本收藏号逐字位对账。"
                size="small"
              />
            ) : (
              <Table<ReconciliationBatch>
                rowKey="id"
                size="small"
                pagination={false}
                columns={batchColumns}
                dataSource={batches}
                rowClassName={(record) => (record.id === selectedBatch?.id ? 'ant-table-row-selected' : '')}
                onRow={(record) => ({ onClick: () => dispatch(setSelectedBatch(record.id)) })}
              />
            )}
          </Card>
        </Col>
        <Col span={24} style={{ marginTop: 16 }}>
          <Card
            className="gb-table-card"
            title={selectedBatch ? `批次 ${selectedBatch.id} 的字位对账项` : '字位对账项'}
            extra={selectedBatch ? <Tag color={RECONCILIATION_ITEM_STATUS_COLOR.matched}>{selectedItems.length} 项</Tag> : null}
            styles={{ body: { padding: 0 } }}
          >
            {!selectedBatch ? (
              <EmptyPanel title="请选择批次" description="点击上方批次查看该批收藏号下的对账项。" size="small" />
            ) : selectedItems.length === 0 ? (
              <EmptyPanel title="该批次没有字位项" description="请确认合作馆文件中的 losses 数组。" size="small" />
            ) : (
              <Table<ReconciliationItem>
                rowKey="id"
                size="small"
                pagination={{ pageSize: 8 }}
                columns={itemColumns}
                dataSource={selectedItems}
                scroll={{ x: 1180 }}
              />
            )}
          </Card>
        </Col>
      </Row>

      <Modal
        open={reviewing !== null}
        title="编目员看物认定"
        onCancel={() => setReviewing(null)}
        onOk={() => void submitReview()}
        okText="确认认定"
        cancelText="取消"
        destroyOnClose
      >
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message={
            reviewing
              ? `${reviewing.item.collectionNo} · ${encodeCoord(reviewing.item.lineNo, reviewing.item.charNo)} · ${
                  reviewing.decision === 'confirmPartner'
                    ? '采合作馆字位'
                    : reviewing.decision === 'rejectPartner'
                      ? '不采合作馆字位'
                      : reviewing.decision === 'confirmLocal'
                        ? '维持本馆损泐'
                        : '撤销本馆损泐'
                }`
              : ''
          }
          description="只有看过实物的编目员确认后，本馆损泐才会新增、维持或核销。"
        />
        <Form form={reviewForm} layout="vertical" preserve={false}>
          <Form.Item name="reviewedBy" label="认定编目员" rules={[{ required: true, message: '请填写编目员姓名' }]}>
            <Input placeholder="如：傅砚" />
          </Form.Item>
          <Form.Item name="reviewNote" label="实物备注">
            <Input.TextArea rows={3} placeholder="记录看物依据，可留空" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
