import { trim } from 'ramda';

const reg = /<([\S]{1,})[^>]*>([^\3]*)(<\/\1>)/gim;

export default function trimHtmlTag(input) {
  if (!input) return;
  const regexpResult = new RegExp(reg).exec(trim(input));
  return regexpResult ? trim(regexpResult[2]) : trim(input);
};
