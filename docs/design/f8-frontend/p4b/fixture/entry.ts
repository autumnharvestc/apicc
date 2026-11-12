import {createApp,h} from 'vue';
import seed from './seed.json';
const preview=new URLSearchParams(location.search).get('view')==='preview';
if(preview){
  await import('@desktop/styles/theme.css');
  const {ConfigProvider}=await import('ant-design-vue');
  const {initI18n}=await import('@desktop/i18n/bridge');
  const {default:ThemeLanguageToggle}=await import('@desktop/components/ThemeLanguageToggle.vue');
  const {default:DocumentPreview}=await import('@desktop/components/DocumentPreview.vue');
  const {i18n}=initI18n();
  createApp({render:()=>h(ConfigProvider,null,()=>h('div',{style:'padding:16px;max-width:1200px;margin:auto'},[h(ThemeLanguageToggle),h(DocumentPreview,{status:'ready',result:seed.preview})]))}).use(i18n).mount('#app');
}else{
  const {default:PublicApp}=await import('@public/App.vue');
  createApp({render:()=>h(PublicApp,{artifact:seed.publication})}).mount('#app');
}
