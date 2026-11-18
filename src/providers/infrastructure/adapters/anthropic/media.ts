import type { NormalizedChatRequest } from '@/providers/domain/capabilities.ts';
import { resolveDialect } from '@/providers/domain/dialect.ts';
import type { OutgoingBlock } from './types.ts';

export async function resolveMediaBlocks(req: NormalizedChatRequest): Promise<OutgoingBlock[][]> {
  const perMessage: OutgoingBlock[][] = [];
  const nativePdf = resolveDialect(req.provider).documentInput.pdf === 'native';

  for (const message of req.messages) {
    const blocks: OutgoingBlock[] = [];
    for (const part of message.parts) {
      if (part.type === 'image') {
        blocks.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: part.file.mimeType,
            data: Buffer.from(await part.file.read()).toString('base64'),
          },
        });
        continue;
      }
      if (part.type !== 'document') continue;

      if (part.preferNative && part.file.mimeType === 'application/pdf' && nativePdf) {
        blocks.push({
          type: 'document',
          source: {
            type: 'base64',
            media_type: 'application/pdf',
            data: Buffer.from(await part.file.read()).toString('base64'),
          },
        });
        continue;
      }

      if (part.extractedText !== undefined && part.extractedText.length > 0) {
        blocks.push({
          type: 'text',
          text: `<attached_document name="${part.file.name}" untrusted="true">\n${part.extractedText}\n</attached_document>`,
        });
      }
    }
    perMessage.push(blocks);
  }

  return perMessage;
}
