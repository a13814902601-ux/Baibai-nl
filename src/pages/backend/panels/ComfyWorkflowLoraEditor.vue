<script setup lang="ts">
import {
  addWorkflowLora,
  editWorkflowLora,
  readWorkflowLoras,
  removeWorkflowLora,
  type WorkflowLora,
} from '@/backends/comfyWorkflowLoras';
import BbiCombo from '@/components/BbiCombo.vue';
import Icon from '@/components/Icon.vue';
import { computed, reactive, ref } from 'vue';

const props = defineProps<{
  modelValue: string;
  options: string[];
  canFetch: boolean;
  fetching: boolean;
  fetchStatus: string;
}>();

const emit = defineEmits<{
  'update:modelValue': [next: string];
  'fetch-options': [];
}>();

const state = computed(() => {
  if (!props.modelValue.trim()) return { loras: [], error: '粘贴 API 格式工作流后可编辑 LoRA。' };
  try {
    return { loras: readWorkflowLoras(props.modelValue), error: '' };
  } catch (error) {
    return { loras: [], error: error instanceof Error ? error.message : String(error) };
  }
});

const nameDrafts = reactive(new Map<string, string>());
const newName = ref('');

function save(apply: (template: string) => string): boolean {
  try {
    const next = apply(props.modelValue);
    if (next !== props.modelValue) emit('update:modelValue', next);
    return true;
  } catch (error) {
    toastr.error(error instanceof Error ? error.message : String(error), 'LoRA 编辑失败');
    return false;
  }
}

function draftName(node: WorkflowLora, value: string) {
  nameDrafts.set(node.id, value);
  if (props.options.includes(value)) commitName(node);
}

function commitName(node: WorkflowLora) {
  const value = nameDrafts.get(node.id);
  nameDrafts.delete(node.id);
  if (value !== undefined) save(template => editWorkflowLora(template, node.id, { field: 'lora_name', value }));
}

function commitStrength(node: WorkflowLora, field: 'strength_model' | 'strength_clip', event: Event) {
  const input = event.target as HTMLInputElement;
  if (!save(template => editWorkflowLora(template, node.id, { field, value: input.valueAsNumber }))) {
    const current = field === 'strength_model' ? node.strengthModel : node.strengthClip;
    input.value = current === null ? '' : String(current);
  }
}

function add() {
  if (save(template => addWorkflowLora(template, newName.value))) newName.value = '';
}

function remove(id: string) {
  if (save(template => removeWorkflowLora(template, id))) nameDrafts.delete(id);
}
</script>

<template>
  <section class="custom-loras" aria-label="工作流 LoRA">
    <div class="custom-loras-head">
      <span class="bbi-field-label">工作流 LoRA</span>
      <button
        v-if="!state.error && (canFetch || options.length)"
        type="button"
        class="bbi-btn bbi-btn-sm"
        :disabled="!canFetch || fetching"
        @click="emit('fetch-options')"
      >
        <Icon name="refresh" :size="12" />
        {{ fetching ? '拉取中…' : options.length ? '刷新 LoRA 列表' : '拉取 LoRA 列表' }}
      </button>
    </div>
    <p v-if="state.error" class="bbi-field-hint custom-lora-hint">{{ state.error }}</p>
    <template v-else>
      <div v-for="node in state.loras" :key="node.id" class="custom-lora">
        <div class="custom-lora-head">
          <span>#{{ node.id }} · {{ node.classType }}</span>
          <button
            type="button"
            class="bbi-btn bbi-btn-sm custom-lora-delete"
            :aria-label="`删除 LoRA 节点 #${node.id}`"
            @click="remove(node.id)"
          >
            <Icon name="trash" :size="14" />
            删除
          </button>
        </div>
        <span class="custom-lora-label">文件名</span>
        <div v-if="node.name !== null" @focusout="commitName(node)" @keydown.enter="commitName(node)">
          <BbiCombo
            :model-value="nameDrafts.get(node.id) ?? node.name"
            :options="options"
            :aria-label="`LoRA 节点 #${node.id} 文件名`"
            placeholder="LoRA 文件名"
            @update:model-value="draftName(node, $event)"
          />
        </div>
        <p v-else class="bbi-field-hint custom-lora-hint">请在 JSON 中编辑此字段。</p>
        <div class="custom-lora-strengths">
          <label class="custom-lora-strength">
            <span class="custom-lora-label">模型强度</span>
            <input
              v-if="node.strengthModel !== null"
              class="bbi-input"
              :value="node.strengthModel"
              type="number"
              min="-100"
              max="100"
              step="0.01"
              @change="commitStrength(node, 'strength_model', $event)"
            />
            <span v-else class="bbi-field-hint custom-lora-hint">请在 JSON 中编辑。</span>
          </label>
          <label v-if="node.classType === 'LoraLoader'" class="custom-lora-strength">
            <span class="custom-lora-label">CLIP 强度</span>
            <input
              v-if="node.strengthClip !== null"
              class="bbi-input"
              :value="node.strengthClip"
              type="number"
              min="-100"
              max="100"
              step="0.01"
              @change="commitStrength(node, 'strength_clip', $event)"
            />
            <span v-else class="bbi-field-hint custom-lora-hint">请在 JSON 中编辑。</span>
          </label>
        </div>
      </div>
      <p v-if="!state.loras.length" class="bbi-field-hint custom-lora-hint">没有识别到原生 LoRA 节点。</p>
      <form class="custom-lora-add" @submit.prevent="add">
        <BbiCombo
          v-model="newName"
          :options="options"
          aria-label="新增 LoRA 文件名"
          placeholder="LoRA 文件名"
        />
        <button type="submit" class="bbi-btn" :disabled="!newName.trim()">
          <Icon name="plus" :size="14" />
          添加 LoRA
        </button>
      </form>
      <p v-if="fetchStatus" class="bbi-field-hint custom-lora-hint">{{ fetchStatus }}</p>
    </template>
  </section>
</template>

<style scoped>
.custom-loras {
  display: grid;
  gap: 8px;
  min-width: 0;
  margin: 12px 0;
}
.custom-loras-head,
.custom-lora-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
}
.custom-loras-head {
  padding-bottom: 6px;
  border-bottom: 1px dashed var(--bbi-line);
}
.custom-lora {
  display: grid;
  gap: 6px;
  min-width: 0;
  border: 1px solid var(--bbi-line);
  border-radius: var(--bbi-radius-sm);
  padding: 8px 10px 10px;
}
.custom-lora-head {
  color: var(--bbi-ink-soft);
  font-size: 12px;
  overflow-wrap: anywhere;
}
.custom-lora-label {
  color: var(--bbi-ink-soft);
  font-size: 12px;
}
.custom-lora-strengths {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}
.custom-lora-strength {
  display: grid;
  gap: 3px;
  min-width: 0;
}
.custom-lora-strength input {
  width: 100%;
}
.custom-lora-delete {
  color: var(--bbi-danger);
}
.custom-lora-hint {
  margin: 0;
  font-size: 12px;
  overflow-wrap: anywhere;
}
.custom-lora-add {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 8px;
}
@media (max-width: 640px) {
  .custom-loras button,
  .custom-loras input,
  .custom-loras :deep(.bbi-combo-input) {
    min-height: 44px;
  }
  .custom-loras input,
  .custom-loras :deep(.bbi-combo-input) {
    font-size: 16px;
  }
}
</style>
