import React from 'react';
import {createRoot} from 'react-dom/client';
import App from './App';
import './style.css';
class AppErrorBoundary extends React.Component<React.PropsWithChildren, {failed:boolean}> {
 state={failed:false};
 static getDerivedStateFromError(){return {failed:true}}
 componentDidCatch(error:Error){console.error('WebForge: erro na interface',error)}
 render(){return this.state.failed?<main style={{padding:32,color:'#fff',background:'#111',minHeight:'100vh',fontFamily:'sans-serif'}}><h1>Não foi possível carregar a interface</h1><p>Abra o Console (F12) para consultar o erro e reinicie o servidor.</p><button onClick={()=>window.location.reload()}>Recarregar</button></main>:this.props.children}
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><AppErrorBoundary><App/></AppErrorBoundary></React.StrictMode>);
